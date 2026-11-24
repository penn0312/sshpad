// Unquoted return + pause is the Send String separator recognized in Auto mode.
// Quoted Shell text and escaped backslashes can still be sent literally.
export function usesSendString(command, mode) {
  if (mode === 'send-string') return true;
  if (mode === 'shell') return false;
  return !/["'`]/.test(command) && /(?:^|[^\\])(?:\\\\)*\\[nr]\\p/.test(command);
}

export function parseSendString(value) {
  const steps = [];
  let input = '';
  let delay = 0;
  let totalDelay = 0;

  function submit() {
    if (!input.trim()) throw new Error('每次回车前请输入要发送的文本。');
    steps.push({ input, delay });
    input = '';
    delay = 0;
  }

  for (let i = 0; i < value.length; i += 1) {
    const character = value[i];
    if (character !== '\\') {
      input += character;
      continue;
    }

    i += 1;
    switch (value[i]) {
      case '\\':
        input += '\\';
        break;
      case 'n':
      case 'r':
        submit();
        break;
      case 'p':
        if (input) throw new Error('请把暂停放在回车之后。');
        delay += 1000;
        totalDelay += 1000;
        break;
      default:
        throw new Error('发送字符串仅支持 \\n、\\r、\\p 和 \\\\。');
    }
  }

  if (input) submit();
  if (!steps.length || delay) throw new Error('暂停后请输入要发送的文本。');
  if (steps.length > 20 || totalDelay > 20000) throw new Error('一次最多发送 20 行，总暂停不超过 20 秒。');
  return steps;
}

export function longestSubmission(steps) {
  return Math.max(...steps.map(({ input }) => Array.from(input).length + 1));
}
