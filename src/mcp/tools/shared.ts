export function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function errorContent(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
