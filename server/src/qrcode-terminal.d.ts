declare module "qrcode-terminal" {
  interface QrCode {
    generate(text: string, opts?: { small?: boolean }): void;
    generate(text: string, opts: { small?: boolean }, cb: (out: string) => void): void;
  }
  const qrcode: QrCode;
  export default qrcode;
}
