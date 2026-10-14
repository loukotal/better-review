/** Retains a bounded UTF-8 tail while continuing to drain the execution stream. */
export class BoundedOutput {
  private bytes = Buffer.alloc(0);
  totalBytes = 0;
  constructor(readonly limit = 24000) {}
  append(chunk: Uint8Array) {
    this.totalBytes += chunk.byteLength;
    const tail = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.bytes =
      tail.length >= this.limit
        ? Buffer.from(tail.subarray(tail.length - this.limit))
        : Buffer.concat([
            this.bytes.subarray(Math.max(0, this.bytes.length + tail.length - this.limit)),
            tail,
          ]);
  }
  text() {
    let start = 0;
    // A truncated UTF-8 sequence may start with continuation bytes.
    if (this.totalBytes > this.bytes.length)
      while (start < this.bytes.length && (this.bytes[start]! & 0xc0) === 0x80) start++;
    const text = this.bytes.subarray(start).toString("utf8");
    return this.totalBytes > this.bytes.length
      ? `[${this.totalBytes - this.bytes.length + start} earlier output bytes omitted]\n${text}`
      : text;
  }
}
