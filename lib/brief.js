// The structured brief the aiguilleur hands an agent for a new task (built from the user's own words).
import { fail } from './i18n.js'

const list = v => {
  if (v == null) return []
  if (!Array.isArray(v) || v.length > 20) throw fail('errors.badBrief')
  return v.map(s => { if (typeof s !== 'string' || !s.trim() || s.trim().length > 300) throw fail('errors.badBrief'); return s.trim() })
}

export function validBrief(body) {
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''
  if (!goal || goal.length > 500) throw fail('errors.badBrief')
  const escalate = typeof body.escalate === 'string' ? body.escalate.trim() : ''
  if (body.escalate != null && typeof body.escalate !== 'string' || escalate.length > 300) throw fail('errors.badBrief')
  return { goal, scope: list(body.scope), done: list(body.done), escalate }
}

export const briefText = b => [
  'Task brief',
  `Goal: ${b.goal}`,
  b.scope.length && `Scope (the files or modules you may change): ${b.scope.join(', ')}`,
  b.done.length && ['Done when (check each one before reporting done):', ...b.done.map(d => `- ${d}`)].join('\n'),
  b.escalate && `Escalate to the user before: ${b.escalate}`,
].filter(Boolean).join('\n')
