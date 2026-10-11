export function project(flag: boolean): { action: 'syn.allowed' | 'syn.second'; target: string } {
  if (flag) return { action: 'syn.allowed', target: 'fixed' };
  return { action: 'syn.second', target: 'fixed' };
}
