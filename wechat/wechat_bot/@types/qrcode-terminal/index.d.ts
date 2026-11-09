// Type declaration stub for qrcode-terminal
declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  const qrterm: {
    generate(text: string, options?: Options, callback?: () => void): void;
  };
  export = qrterm;
}
