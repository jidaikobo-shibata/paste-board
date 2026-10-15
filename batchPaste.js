export function combineCandidates(candidates, specification, separator) {
  const indexes = [];
  const parts = specification.trim().split(',');
  if (!specification.trim())
    throw new Error('番号を入力してください。');
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match)
      throw new Error('番号は 2-6、1,3,5、1,3-5 の形式で指定してください。');
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > candidates.length)
      throw new Error(`番号は1〜${candidates.length}の昇順の範囲で指定してください。`);
    for (let index = start; index <= end; index++) {
      indexes.push(index - 1);
      if (indexes.length > 1000)
        throw new Error('一度に指定できるのは1000件までです。');
    }
  }
  const text = indexes.map(index => candidates[index].text).join(separator);
  if (text.length > 4 * 1024 * 1024)
    throw new Error('連結結果が大きすぎます。件数を減らしてください。');
  return {text, count: indexes.length};
}
