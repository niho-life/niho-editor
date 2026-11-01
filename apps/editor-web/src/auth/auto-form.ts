import { randomBytes } from "node:crypto";

type AutoFormOptions = {
  readonly target: string;
  readonly fields: Readonly<Record<string, string>>;
  /** 同一 origin への relay だけ `'self'`。cross-origin start は固定の送信先 origin。 */
  readonly formAction: string;
  readonly title: string;
  readonly message: string;
  readonly submitLabel: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

/**
 * 認証情報を URL に置かず、固定の信頼済み送信先へ一度だけ POST する独立 HTML。
 * nonce は要求 header や provider の注入値を使わず、この文書専用に生成する。
 */
export function autoFormResponse(options: AutoFormOptions): Response {
  const nonce = randomBytes(18).toString("base64url");
  const inputs = Object.entries(options.fields).map(([name, value]) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  ).join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(options.title)}</title></head><body><main><p>${escapeHtml(options.message)}</p><form id="auth-form" method="post" action="${escapeHtml(options.target)}">${inputs}<button type="submit">${escapeHtml(options.submitLabel)}</button></form></main><script nonce="${nonce}">document.getElementById("auth-form").submit();</script></body></html>`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `form-action ${options.formAction}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
  return new Response(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
