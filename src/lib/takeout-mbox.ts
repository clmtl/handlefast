export const maxTakeoutMessageBytes = 19 * 1024 * 1024;
const chunkSize = 1024 * 1024;
const separator = /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /;
const decoder = new TextDecoder();

export type TakeoutMessage = { file: Blob; start: number; end: number; date: number };

export async function indexTakeout(file: Blob) {
  const messages: TakeoutMessage[] = [];
  let start: number | undefined;
  let date = 0;
  let lineStart = 0;
  let prefix = "";
  let inHeaders = false;

  function finish(end: number) {
    if (start !== undefined && end > start) messages.push({ file, start, end, date });
  }

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    let cursor = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline < 0 ? bytes.length : newline;
      prefix += decoder.decode(bytes.subarray(cursor, Math.min(end, cursor + 512 - prefix.length)));
      if (newline < 0) break;
      const nextLine = offset + newline + 1;
      const line = prefix.trimEnd();
      if (separator.test(line)) {
        finish(lineStart);
        start = nextLine;
        date = Date.parse(line.replace(/^From \S+ /, "")) || 0;
        inHeaders = true;
      } else if (inHeaders) {
        if (!line) inHeaders = false;
        if (/^date:/i.test(line)) date = Date.parse(line.slice(5).trim()) || date;
      }
      prefix = "";
      lineStart = nextLine;
      cursor = newline + 1;
    }
  }
  finish(file.size);
  return messages;
}

export async function takeoutOriginal(message: TakeoutMessage) {
  const bytes = new Uint8Array(await message.file.slice(message.start, message.end).arrayBuffer());
  // mboxrd escapes body lines starting with From, including already escaped lines.
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let start = 0;
  for (let line = 0; line < bytes.length; ) {
    let prefix = line;
    while (bytes[prefix] === 62) prefix++;
    if (
      prefix > line &&
      bytes[prefix] === 70 &&
      bytes[prefix + 1] === 114 &&
      bytes[prefix + 2] === 111 &&
      bytes[prefix + 3] === 109 &&
      bytes[prefix + 4] === 32
    ) {
      parts.push(bytes.subarray(start, line));
      start = line + 1;
    }
    const next = bytes.indexOf(10, line);
    if (next < 0) break;
    line = next + 1;
  }
  parts.push(bytes.subarray(start));
  return new Blob(parts, { type: "message/rfc822" });
}
