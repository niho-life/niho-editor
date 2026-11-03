BEGIN;

-- Editor 内の日本語原文と、本人が確認して Experience へ公開する独立した英語 page の対応。
-- 本文と翻訳候補は pages または暗号化 envelope にだけ置く。この表には対応と確認済み revision だけを置く。
CREATE TABLE page_translation_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- purge 後は NULL になり、target の既存公開版は残る。detached_at が NULL なら「原文不明」。
  source_page_id uuid REFERENCES pages (id) ON DELETE SET NULL,
  target_page_id uuid NOT NULL,
  reviewed_source_revision integer CHECK (reviewed_source_revision IS NULL OR reviewed_source_revision > 0),
  reviewed_target_revision integer CHECK (reviewed_target_revision IS NULL OR reviewed_target_revision > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  detached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner, id),
  UNIQUE (owner, target_page_id),
  UNIQUE (target_page_id),
  FOREIGN KEY (owner, target_page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (source_page_id IS NULL OR source_page_id <> target_page_id),
  CHECK (detached_at IS NULL OR source_page_id IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX page_translation_relations_source_active_idx
  ON page_translation_relations (source_page_id)
  WHERE source_page_id IS NOT NULL AND detached_at IS NULL;

-- provider 呼出しの固定入力と候補は AES-256-GCM envelope。owner/proposal/purpose/expiry は暗号の AAD にも束縛する。
-- key 本体、原文、指示、候補の文は DB の平文列へ置かない。
CREATE TABLE page_translation_proposals (
  id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- source purge 後も複製台帳を失わないため nullable。source_identity は冪等性の安定した識別子。
  source_page_id uuid REFERENCES pages (id) ON DELETE SET NULL,
  source_identity uuid NOT NULL,
  -- 初回はまだ pages に無い、proposal 固定の id。採用時にこの id で private EN page を作る。
  target_page_id uuid NOT NULL,
  relation_id uuid REFERENCES page_translation_relations (id) ON DELETE SET NULL,
  relation_version integer CHECK (relation_version IS NULL OR relation_version > 0),
  generation integer NOT NULL CHECK (generation > 0),
  operation_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  source_revision integer NOT NULL CHECK (source_revision > 0),
  target_revision integer CHECK (target_revision IS NULL OR target_revision > 0),
  status text NOT NULL CHECK (status IN ('generating', 'ready', 'failed', 'adopted', 'expired')),
  lease_until timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  payload_key_id text CHECK (payload_key_id IS NULL OR payload_key_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  payload_nonce bytea CHECK (payload_nonce IS NULL OR octet_length(payload_nonce) = 12),
  payload_ciphertext bytea,
  payload_tag bytea CHECK (payload_tag IS NULL OR octet_length(payload_tag) = 16),
  field_count integer NOT NULL CHECK (field_count BETWEEN 0 AND 256),
  codepoint_count integer NOT NULL CHECK (codepoint_count BETWEEN 0 AND 20000),
  omissions text[] NOT NULL DEFAULT '{}'::text[],
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner, source_identity, operation_id),
  UNIQUE (owner, source_identity, generation),
  CHECK ((payload_key_id IS NULL) = (payload_nonce IS NULL)),
  CHECK ((payload_key_id IS NULL) = (payload_ciphertext IS NULL)),
  CHECK ((payload_key_id IS NULL) = (payload_tag IS NULL)),
  CHECK (status IN ('generating', 'ready') OR payload_key_id IS NULL),
  CHECK ((status = 'generating') = (lease_until IS NOT NULL)),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '24 hours'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX page_translation_proposals_owner_source_idx
  ON page_translation_proposals (owner, source_identity, created_at DESC);
CREATE INDEX page_translation_proposals_expiry_idx
  ON page_translation_proposals (expires_at)
  WHERE status IN ('generating', 'ready', 'failed');

-- 画像複製は proposal ごとの決定的な写し先へ収束する。本文・alt・caption・credit はここへ複製しない。
-- copied なのに proposal の DB CAS が負けた object も、expiry purge が返せるよう追跡したままにする。
CREATE TABLE page_translation_asset_copies (
  proposal_id uuid NOT NULL REFERENCES page_translation_proposals (id) ON DELETE CASCADE,
  source_asset_id uuid NOT NULL,
  target_asset_id uuid NOT NULL,
  source_object_path text NOT NULL CHECK (
    length(source_object_path) BETWEEN 1 AND 1024
    AND source_object_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND source_object_path !~ '(^|/)\.\.(/|$)'
  ),
  target_object_path text NOT NULL CHECK (
    length(target_object_path) BETWEEN 1 AND 1024
    AND target_object_path !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND target_object_path !~ '(^|/)\.\.(/|$)'
  ),
  source_generation text CHECK (source_generation IS NULL OR source_generation ~ '^[1-9][0-9]{0,30}$'),
  state text NOT NULL CHECK (state IN ('planned', 'copied', 'reused', 'adopted', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proposal_id, source_asset_id),
  UNIQUE (proposal_id, target_asset_id),
  UNIQUE (proposal_id, target_object_path),
  CHECK (source_object_path <> target_object_path),
  CHECK (state NOT IN ('copied', 'adopted') OR source_generation IS NOT NULL),
  CHECK (updated_at >= created_at)
);

-- relation は現在の同一 owner の ja -> en だけ。直接 SQL で不正な対応を作れないようにする。
CREATE FUNCTION check_page_translation_relation() RETURNS trigger
LANGUAGE plpgsql AS $translation_guard$
DECLARE
  source_owner text;
  source_lang text;
  target_owner text;
  target_lang text;
BEGIN
  SELECT owner, lang INTO target_owner, target_lang FROM pages WHERE id = NEW.target_page_id;
  IF target_owner IS DISTINCT FROM NEW.owner OR target_lang IS DISTINCT FROM 'en' THEN
    RAISE EXCEPTION 'invalid managed translation target';
  END IF;
  IF NEW.source_page_id IS NOT NULL THEN
    SELECT owner, lang INTO source_owner, source_lang FROM pages WHERE id = NEW.source_page_id;
    IF source_owner IS DISTINCT FROM NEW.owner OR source_lang IS DISTINCT FROM 'ja' THEN
      RAISE EXCEPTION 'invalid managed translation source';
    END IF;
  END IF;
  RETURN NEW;
END;
$translation_guard$;

CREATE CONSTRAINT TRIGGER page_translation_relations_guard
AFTER INSERT OR UPDATE OF owner, source_page_id, target_page_id
ON page_translation_relations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION check_page_translation_relation();

-- relation の更新を時刻粒度に依存しない CAS token にする。source の ON DELETE SET NULL も含む。
CREATE FUNCTION bump_page_translation_relation_version() RETURNS trigger
LANGUAGE plpgsql AS $translation_relation_version$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at);
  RETURN NEW;
END;
$translation_relation_version$;

CREATE TRIGGER page_translation_relations_bump_version
BEFORE UPDATE ON page_translation_relations
FOR EACH ROW EXECUTE FUNCTION bump_page_translation_relation_version();

-- 画像の権利情報や alt は assets にも正本がある。通常 page の revision 契約は変えず、
-- managed source/target の画像メタデータが変わったときだけ既存の確認印を無効にする。
CREATE FUNCTION invalidate_translation_review_for_asset_metadata() RETURNS trigger
LANGUAGE plpgsql AS $translation_asset_review$
BEGIN
  IF OLD.alt IS NOT DISTINCT FROM NEW.alt
     AND OLD.credit IS NOT DISTINCT FROM NEW.credit
     AND OLD.consent IS NOT DISTINCT FROM NEW.consent THEN
    RETURN NEW;
  END IF;
  UPDATE page_translation_relations
     SET reviewed_source_revision = CASE WHEN source_page_id = NEW.page_id THEN NULL ELSE reviewed_source_revision END,
         reviewed_target_revision = CASE WHEN target_page_id = NEW.page_id THEN NULL ELSE reviewed_target_revision END,
         updated_at = GREATEST(clock_timestamp(), updated_at)
   WHERE owner = NEW.owner AND detached_at IS NULL
     AND (source_page_id = NEW.page_id OR target_page_id = NEW.page_id);
  RETURN NEW;
END;
$translation_asset_review$;

CREATE TRIGGER assets_invalidate_translation_review
AFTER UPDATE OF alt, credit, consent ON assets
FOR EACH ROW EXECUTE FUNCTION invalidate_translation_review_for_asset_metadata();

-- source purge は候補内容を即時に消すが、複製済み object の回収位置は台帳に残す。
CREATE FUNCTION expire_translation_proposals_for_deleted_page() RETURNS trigger
LANGUAGE plpgsql AS $translation_source_purge$
BEGIN
  UPDATE page_translation_proposals
     SET status = CASE WHEN status = 'adopted' THEN status ELSE 'expired' END,
         lease_until = NULL,
         error_code = CASE WHEN status = 'adopted' THEN error_code ELSE 'source_removed' END,
         payload_key_id = NULL,
         payload_nonce = NULL,
         payload_ciphertext = NULL,
         payload_tag = NULL,
         updated_at = GREATEST(clock_timestamp(), updated_at)
   WHERE owner = OLD.owner AND source_page_id = OLD.id;
  RETURN OLD;
END;
$translation_source_purge$;

CREATE TRIGGER pages_expire_translation_proposals
BEFORE DELETE ON pages
FOR EACH ROW EXECUTE FUNCTION expire_translation_proposals_for_deleted_page();

COMMIT;
