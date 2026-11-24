// Detects shortcuts that appear to carry literal credentials.
// Bastion users really do paste passwords into shortcuts, so this WARNS
// instead of blocking: silently breaking a working button is worse than a badge.
// Every rule captures the secret as group 1 so redaction stays exact.
const RULES = [
  // -pSECRET / --password=... / -pwd ...
  // The mask character is excluded so a redacted command never re-matches.
  ['明文密码参数', /(?:^|\s)(?:-p|--password[=\s]|-pwd[=\s])["']?([^\s"';&|-\u2022][^\s"';&|\u2022]{5,})/i],
  // redis-cli -a <token> / --auth <token> / --token <token>
  ['明文令牌参数', /(?:^|\s)(?:--auth|--auth-token|--token|-a)[=\s]+["']?([A-Za-z0-9_.\-]{16,})/],
  // Covers MYSQL_PWD, DB_PASSWORD, REDISCLI_AUTH and friends.
  ['环境变量赋值', /\b(?!OLDPWD\b|PWD\b)[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|PASS|SECRET|TOKEN|API_?KEY|AUTH|KEY)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"';|&\u2022]+))/],
  ['URL 内嵌凭据', /(?:[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@\u2022]+)(?=@)/i],
  ['Bearer 令牌', /\bBearer\s+([A-Za-z0-9\-._~+/]{16,})/i],
];

// A bare "-p" only tells the tool to prompt, which is the safe form.
const PROMPT_ONLY = /(?:^|\s)-p(?:\s|$)/;
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

export function credentialHint(command) {
  if (typeof command !== 'string' || !command) return null;
  for (const [label, pattern] of RULES) {
    const match = pattern.exec(command);
    const secret = match && match.slice(1).find(group => typeof group === 'string' && group);
    if (!secret) continue;
    if (label === '明文密码参数' && PROMPT_ONLY.test(command)) continue;
    return { label, secret };
  }
  return null;
}

export function redactCommand(command) {
  let output = String(command ?? '');
  for (const [label, pattern] of RULES) {
    output = output.replace(pattern, (whole, ...rest) => {
      const secret = rest.find(group => typeof group === 'string' && group);
      if (!secret) return whole;
      const index = whole.lastIndexOf(secret);
      if (index < 0) return whole;
      return whole.slice(0, index) + MASK + whole.slice(index + secret.length);
    });
  }
  return output;
}

export function hasCredential(command) {
  return credentialHint(command) !== null;
}