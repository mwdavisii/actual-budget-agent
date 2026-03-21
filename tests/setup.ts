// Polyfill: @actual-app/api accesses navigator.platform which doesn't exist in Node
if (typeof globalThis.navigator === 'undefined') {
  (globalThis as any).navigator = { platform: '' };
}
