// Type declaration stub for qrcode-terminal (no @types package available)
declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  function generate(text: string, options?: Options, callback?: () => void): void;
  export default { generate };
}
