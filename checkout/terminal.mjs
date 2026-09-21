import { stripVTControlCharacters } from 'node:util';

const clean = value => stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}]/gu,' ').trim();
const tones = { heading:'1;36', success:'32', attention:'33' };

// Append-only output keeps previous attempts available in terminal scrollback.
// Labels carry the meaning even when ANSI color is disabled or output is redirected.
export function createTerminal({ stream = process.stdout, write = line=>stream.write(`${line}\n`),
  columns = ()=>stream.columns, color = Boolean(stream.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb') } = {}) {
  const width = () => Math.max(20,Math.min(88,Number(columns()) || 80));
  const tint = (text,tone) => color && tones[tone] ? `\x1b[${tones[tone]}m${text}\x1b[0m` : text;
  function paragraph(value,{ prefix = '  ', continuation = prefix, tone } = {}) {
    const words = clean(value).split(/\s+/);
    let line = prefix, content = false;
    for (const word of words) {
      let rest = word;
      if (content && line.length + 1 + rest.length > width()) {
        write(tint(line,tone)); line = continuation; content = false;
      }
      if (content) line += ' ';
      // Long single words (for example, a nickname) must also fit narrow terminals.
      while (rest.length > width() - line.length) {
        const available = width() - line.length;
        write(tint(line + rest.slice(0,available),tone)); rest = rest.slice(available); line = continuation;
      }
      line += rest; content = true;
    }
    if (line.trim()) write(tint(line,tone));
  }
  function section(title,tone = 'heading') {
    write(''); paragraph(title,{ prefix:'',tone });
    write(tint('-'.repeat(width()),tone)); write('');
  }
  function notice(title,paragraphs,tone = 'attention') {
    section(title,tone);
    for (const text of paragraphs) { paragraph(text); write(''); }
  }
  function checks(title,items,{ comparison = false } = {}) {
    section(title);
    const passed = items.filter(item=>item.ok), failed = items.filter(item=>!item.ok);
    paragraph(`${passed.length} of ${items.length} ${comparison ? 'saved choices match' : 'checks passed'}${failed.length ? ` | ${failed.length} need attention` : ''}.`,{ tone:failed.length ? 'attention' : 'success' });
    if (failed.length) {
      write(''); paragraph('NEEDS ATTENTION',{ tone:'attention' }); write('');
      for (const item of failed) {
        paragraph(item.name,{ prefix:`  [${comparison ? 'DIFF' : 'FIX'}]`.padEnd(9),continuation:'         ',tone:'attention' });
        paragraph(item.help || 'Select the original saved choice in Store checkout and retry.',{ prefix:'         ' });
        write('');
      }
    }
    if (passed.length) {
      write(''); paragraph(comparison ? 'MATCHED' : 'PASSED',{ tone:'success' });
      for (const item of passed) paragraph(item.name,{ prefix:`  [${comparison ? 'MATCH' : 'PASS'}]`.padEnd(9),continuation:'         ',tone:'success' });
    }
    write('');
  }
  async function prompt(ask,message) {
    write(''); paragraph(message); write('');
    const answer = await ask('  > ');
    write('');
    return answer;
  }
  return { section,notice,checks,prompt,text:paragraph,blank:()=>write(''),
    list:items=>items.forEach((item,index)=>paragraph(item,{ prefix:`  ${index+1}. `,continuation:'     ' })) };
}
