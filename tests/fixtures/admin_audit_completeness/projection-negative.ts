export function project(request: any): { action: 'syn.allowed'; target: string } {
  return { action: request.action as 'syn.allowed', target: request.target };
}
