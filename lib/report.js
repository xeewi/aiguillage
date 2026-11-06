// The block every agent ends its turn with (briefing, lib/agent.js): its status and what it did or didn't check.
export const REPORT_RULES = [
  'End every turn with this block, last in your reply (the user and Aiguillage read it):',
  '```aig-report',
  'status: done | blocked | decision',
  'checks: the commands you ran to verify your work (tests, build, lint) and their result, or none',
  'unverified: what you did not verify',
  'needs: the decision or answer you need from the user, or none',
  '```',
  'status: done = finished, and verified as far as you could; blocked = you cannot go on; decision = the user has to choose before you go on.',
].join('\n')

const BLOCK = /```aig-report[ \t]*\n([\s\S]*?)\n?```/g
const lastBlock = text => [...text.matchAll(BLOCK)].at(-1)

// The last block's fields ('' when absent; status null unless done/blocked/decision) and the text without it.
export function parseReport(text) {
  const m = lastBlock(text)
  if (!m) return { status: null, checks: '', unverified: '', needs: '', body: text }
  const f = Object.fromEntries(m[1].split('\n').map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]))
  return {
    status: ['done', 'blocked', 'decision'].includes(f.status) ? f.status : null,
    checks: f.checks ?? '', unverified: f.unverified ?? '', needs: f.needs ?? '',
    body: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(),
  }
}

// At most max characters of the body, then the block whole: it is what the reader needs most.
export function excerpt(text, max) {
  if (text.length <= max) return text
  const m = lastBlock(text), at = m ? m.index : text.length, tail = text.slice(at)
  return text.slice(0, Math.max(0, max - (tail && tail.length + 2))).trimEnd() + '…' + (tail && '\n\n' + tail)
}
