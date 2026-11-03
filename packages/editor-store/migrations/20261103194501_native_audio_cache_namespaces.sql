BEGIN;

-- Mac の一時音声・端末内結果を、公開され得る owner id から導出できない namespace へ分離する。
-- 認証方式を替えた場合も同じ namespace を共有せず、同じ owner + auth mode の再ログインでは再利用する。
CREATE TABLE native_audio_cache_namespaces (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  auth_mode text NOT NULL CHECK (auth_mode IN ('niho', 'google', 'stub')),
  namespace uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, auth_mode)
);

COMMIT;
