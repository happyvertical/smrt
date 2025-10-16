import { a as generateDeclarationsFromCLI } from "./index-Dw0X9BVV.js";
import fsp, { rm, mkdir as mkdir$1, access, cp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir, homedir } from "node:os";
import path__default, { posix, basename, win32, join, resolve, dirname as dirname$1 } from "node:path";
import { pathToFileURL } from "node:url";
import EE, { EventEmitter as EventEmitter$1 } from "events";
import fs from "fs";
import { EventEmitter } from "node:events";
import Stream from "node:stream";
import { StringDecoder } from "node:string_decoder";
import fs__default from "node:fs";
import require$$0, { parse as parse$2, dirname } from "path";
import assert from "assert";
import { Buffer as Buffer$1 } from "buffer";
import * as realZlib from "zlib";
import realZlib__default from "zlib";
import assert$1 from "node:assert";
import { randomBytes } from "node:crypto";
import { g as glob } from "./index-Cx2MeuP_.js";
import { spawn } from "node:child_process";
const generateCommands = {
  "generate-types": {
    name: "generate-types",
    description: "Generate TypeScript declarations from SMRT manifest",
    aliases: ["generate-declarations"],
    args: ["manifest-path"],
    options: {
      "output-dir": {
        type: "string",
        description: "Output directory for generated types"
      }
    },
    handler: async (args, options) => {
      const manifestPath = args[0];
      if (!manifestPath) {
        throw new Error(
          "Manifest path is required: smrt generate-types <manifest-path> [output-dir]"
        );
      }
      const outputDir = options.outputDir || args[1];
      try {
        const cliArgs = outputDir ? [manifestPath, outputDir] : [manifestPath];
        await generateDeclarationsFromCLI(cliArgs);
      } catch (error) {
        throw new Error(
          `Failed to generate types: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
  }
};
const proc = typeof process === "object" && process ? process : {
  stdout: null,
  stderr: null
};
const isStream = (s) => !!s && typeof s === "object" && (s instanceof Minipass || s instanceof Stream || isReadable(s) || isWritable(s));
const isReadable = (s) => !!s && typeof s === "object" && s instanceof EventEmitter && typeof s.pipe === "function" && // node core Writable streams have a pipe() method, but it throws
s.pipe !== Stream.Writable.prototype.pipe;
const isWritable = (s) => !!s && typeof s === "object" && s instanceof EventEmitter && typeof s.write === "function" && typeof s.end === "function";
const EOF$1 = Symbol("EOF");
const MAYBE_EMIT_END = Symbol("maybeEmitEnd");
const EMITTED_END = Symbol("emittedEnd");
const EMITTING_END = Symbol("emittingEnd");
const EMITTED_ERROR = Symbol("emittedError");
const CLOSED = Symbol("closed");
const READ$1 = Symbol("read");
const FLUSH = Symbol("flush");
const FLUSHCHUNK = Symbol("flushChunk");
const ENCODING = Symbol("encoding");
const DECODER = Symbol("decoder");
const FLOWING = Symbol("flowing");
const PAUSED = Symbol("paused");
const RESUME = Symbol("resume");
const BUFFER$1 = Symbol("buffer");
const PIPES = Symbol("pipes");
const BUFFERLENGTH = Symbol("bufferLength");
const BUFFERPUSH = Symbol("bufferPush");
const BUFFERSHIFT = Symbol("bufferShift");
const OBJECTMODE = Symbol("objectMode");
const DESTROYED = Symbol("destroyed");
const ERROR = Symbol("error");
const EMITDATA = Symbol("emitData");
const EMITEND = Symbol("emitEnd");
const EMITEND2 = Symbol("emitEnd2");
const ASYNC = Symbol("async");
const ABORT = Symbol("abort");
const ABORTED$1 = Symbol("aborted");
const SIGNAL = Symbol("signal");
const DATALISTENERS = Symbol("dataListeners");
const DISCARDED = Symbol("discarded");
const defer = (fn) => Promise.resolve().then(fn);
const nodefer = (fn) => fn();
const isEndish = (ev) => ev === "end" || ev === "finish" || ev === "prefinish";
const isArrayBufferLike = (b) => b instanceof ArrayBuffer || !!b && typeof b === "object" && b.constructor && b.constructor.name === "ArrayBuffer" && b.byteLength >= 0;
const isArrayBufferView = (b) => !Buffer.isBuffer(b) && ArrayBuffer.isView(b);
class Pipe {
  src;
  dest;
  opts;
  ondrain;
  constructor(src, dest, opts) {
    this.src = src;
    this.dest = dest;
    this.opts = opts;
    this.ondrain = () => src[RESUME]();
    this.dest.on("drain", this.ondrain);
  }
  unpipe() {
    this.dest.removeListener("drain", this.ondrain);
  }
  // only here for the prototype
  /* c8 ignore start */
  proxyErrors(_er) {
  }
  /* c8 ignore stop */
  end() {
    this.unpipe();
    if (this.opts.end)
      this.dest.end();
  }
}
class PipeProxyErrors extends Pipe {
  unpipe() {
    this.src.removeListener("error", this.proxyErrors);
    super.unpipe();
  }
  constructor(src, dest, opts) {
    super(src, dest, opts);
    this.proxyErrors = (er) => dest.emit("error", er);
    src.on("error", this.proxyErrors);
  }
}
const isObjectModeOptions = (o) => !!o.objectMode;
const isEncodingOptions = (o) => !o.objectMode && !!o.encoding && o.encoding !== "buffer";
class Minipass extends EventEmitter {
  [FLOWING] = false;
  [PAUSED] = false;
  [PIPES] = [];
  [BUFFER$1] = [];
  [OBJECTMODE];
  [ENCODING];
  [ASYNC];
  [DECODER];
  [EOF$1] = false;
  [EMITTED_END] = false;
  [EMITTING_END] = false;
  [CLOSED] = false;
  [EMITTED_ERROR] = null;
  [BUFFERLENGTH] = 0;
  [DESTROYED] = false;
  [SIGNAL];
  [ABORTED$1] = false;
  [DATALISTENERS] = 0;
  [DISCARDED] = false;
  /**
   * true if the stream can be written
   */
  writable = true;
  /**
   * true if the stream can be read
   */
  readable = true;
  /**
   * If `RType` is Buffer, then options do not need to be provided.
   * Otherwise, an options object must be provided to specify either
   * {@link Minipass.SharedOptions.objectMode} or
   * {@link Minipass.SharedOptions.encoding}, as appropriate.
   */
  constructor(...args) {
    const options = args[0] || {};
    super();
    if (options.objectMode && typeof options.encoding === "string") {
      throw new TypeError("Encoding and objectMode may not be used together");
    }
    if (isObjectModeOptions(options)) {
      this[OBJECTMODE] = true;
      this[ENCODING] = null;
    } else if (isEncodingOptions(options)) {
      this[ENCODING] = options.encoding;
      this[OBJECTMODE] = false;
    } else {
      this[OBJECTMODE] = false;
      this[ENCODING] = null;
    }
    this[ASYNC] = !!options.async;
    this[DECODER] = this[ENCODING] ? new StringDecoder(this[ENCODING]) : null;
    if (options && options.debugExposeBuffer === true) {
      Object.defineProperty(this, "buffer", { get: () => this[BUFFER$1] });
    }
    if (options && options.debugExposePipes === true) {
      Object.defineProperty(this, "pipes", { get: () => this[PIPES] });
    }
    const { signal } = options;
    if (signal) {
      this[SIGNAL] = signal;
      if (signal.aborted) {
        this[ABORT]();
      } else {
        signal.addEventListener("abort", () => this[ABORT]());
      }
    }
  }
  /**
   * The amount of data stored in the buffer waiting to be read.
   *
   * For Buffer strings, this will be the total byte length.
   * For string encoding streams, this will be the string character length,
   * according to JavaScript's `string.length` logic.
   * For objectMode streams, this is a count of the items waiting to be
   * emitted.
   */
  get bufferLength() {
    return this[BUFFERLENGTH];
  }
  /**
   * The `BufferEncoding` currently in use, or `null`
   */
  get encoding() {
    return this[ENCODING];
  }
  /**
   * @deprecated - This is a read only property
   */
  set encoding(_enc) {
    throw new Error("Encoding must be set at instantiation time");
  }
  /**
   * @deprecated - Encoding may only be set at instantiation time
   */
  setEncoding(_enc) {
    throw new Error("Encoding must be set at instantiation time");
  }
  /**
   * True if this is an objectMode stream
   */
  get objectMode() {
    return this[OBJECTMODE];
  }
  /**
   * @deprecated - This is a read-only property
   */
  set objectMode(_om) {
    throw new Error("objectMode must be set at instantiation time");
  }
  /**
   * true if this is an async stream
   */
  get ["async"]() {
    return this[ASYNC];
  }
  /**
   * Set to true to make this stream async.
   *
   * Once set, it cannot be unset, as this would potentially cause incorrect
   * behavior.  Ie, a sync stream can be made async, but an async stream
   * cannot be safely made sync.
   */
  set ["async"](a) {
    this[ASYNC] = this[ASYNC] || !!a;
  }
  // drop everything and get out of the flow completely
  [ABORT]() {
    this[ABORTED$1] = true;
    this.emit("abort", this[SIGNAL]?.reason);
    this.destroy(this[SIGNAL]?.reason);
  }
  /**
   * True if the stream has been aborted.
   */
  get aborted() {
    return this[ABORTED$1];
  }
  /**
   * No-op setter. Stream aborted status is set via the AbortSignal provided
   * in the constructor options.
   */
  set aborted(_) {
  }
  write(chunk, encoding, cb) {
    if (this[ABORTED$1])
      return false;
    if (this[EOF$1])
      throw new Error("write after end");
    if (this[DESTROYED]) {
      this.emit("error", Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }));
      return true;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = "utf8";
    }
    if (!encoding)
      encoding = "utf8";
    const fn = this[ASYNC] ? defer : nodefer;
    if (!this[OBJECTMODE] && !Buffer.isBuffer(chunk)) {
      if (isArrayBufferView(chunk)) {
        chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else if (isArrayBufferLike(chunk)) {
        chunk = Buffer.from(chunk);
      } else if (typeof chunk !== "string") {
        throw new Error("Non-contiguous data written to non-objectMode stream");
      }
    }
    if (this[OBJECTMODE]) {
      if (this[FLOWING] && this[BUFFERLENGTH] !== 0)
        this[FLUSH](true);
      if (this[FLOWING])
        this.emit("data", chunk);
      else
        this[BUFFERPUSH](chunk);
      if (this[BUFFERLENGTH] !== 0)
        this.emit("readable");
      if (cb)
        fn(cb);
      return this[FLOWING];
    }
    if (!chunk.length) {
      if (this[BUFFERLENGTH] !== 0)
        this.emit("readable");
      if (cb)
        fn(cb);
      return this[FLOWING];
    }
    if (typeof chunk === "string" && // unless it is a string already ready for us to use
    !(encoding === this[ENCODING] && !this[DECODER]?.lastNeed)) {
      chunk = Buffer.from(chunk, encoding);
    }
    if (Buffer.isBuffer(chunk) && this[ENCODING]) {
      chunk = this[DECODER].write(chunk);
    }
    if (this[FLOWING] && this[BUFFERLENGTH] !== 0)
      this[FLUSH](true);
    if (this[FLOWING])
      this.emit("data", chunk);
    else
      this[BUFFERPUSH](chunk);
    if (this[BUFFERLENGTH] !== 0)
      this.emit("readable");
    if (cb)
      fn(cb);
    return this[FLOWING];
  }
  /**
   * Low-level explicit read method.
   *
   * In objectMode, the argument is ignored, and one item is returned if
   * available.
   *
   * `n` is the number of bytes (or in the case of encoding streams,
   * characters) to consume. If `n` is not provided, then the entire buffer
   * is returned, or `null` is returned if no data is available.
   *
   * If `n` is greater that the amount of data in the internal buffer,
   * then `null` is returned.
   */
  read(n) {
    if (this[DESTROYED])
      return null;
    this[DISCARDED] = false;
    if (this[BUFFERLENGTH] === 0 || n === 0 || n && n > this[BUFFERLENGTH]) {
      this[MAYBE_EMIT_END]();
      return null;
    }
    if (this[OBJECTMODE])
      n = null;
    if (this[BUFFER$1].length > 1 && !this[OBJECTMODE]) {
      this[BUFFER$1] = [
        this[ENCODING] ? this[BUFFER$1].join("") : Buffer.concat(this[BUFFER$1], this[BUFFERLENGTH])
      ];
    }
    const ret = this[READ$1](n || null, this[BUFFER$1][0]);
    this[MAYBE_EMIT_END]();
    return ret;
  }
  [READ$1](n, chunk) {
    if (this[OBJECTMODE])
      this[BUFFERSHIFT]();
    else {
      const c = chunk;
      if (n === c.length || n === null)
        this[BUFFERSHIFT]();
      else if (typeof c === "string") {
        this[BUFFER$1][0] = c.slice(n);
        chunk = c.slice(0, n);
        this[BUFFERLENGTH] -= n;
      } else {
        this[BUFFER$1][0] = c.subarray(n);
        chunk = c.subarray(0, n);
        this[BUFFERLENGTH] -= n;
      }
    }
    this.emit("data", chunk);
    if (!this[BUFFER$1].length && !this[EOF$1])
      this.emit("drain");
    return chunk;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = void 0;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = "utf8";
    }
    if (chunk !== void 0)
      this.write(chunk, encoding);
    if (cb)
      this.once("end", cb);
    this[EOF$1] = true;
    this.writable = false;
    if (this[FLOWING] || !this[PAUSED])
      this[MAYBE_EMIT_END]();
    return this;
  }
  // don't let the internal resume be overwritten
  [RESUME]() {
    if (this[DESTROYED])
      return;
    if (!this[DATALISTENERS] && !this[PIPES].length) {
      this[DISCARDED] = true;
    }
    this[PAUSED] = false;
    this[FLOWING] = true;
    this.emit("resume");
    if (this[BUFFER$1].length)
      this[FLUSH]();
    else if (this[EOF$1])
      this[MAYBE_EMIT_END]();
    else
      this.emit("drain");
  }
  /**
   * Resume the stream if it is currently in a paused state
   *
   * If called when there are no pipe destinations or `data` event listeners,
   * this will place the stream in a "discarded" state, where all data will
   * be thrown away. The discarded state is removed if a pipe destination or
   * data handler is added, if pause() is called, or if any synchronous or
   * asynchronous iteration is started.
   */
  resume() {
    return this[RESUME]();
  }
  /**
   * Pause the stream
   */
  pause() {
    this[FLOWING] = false;
    this[PAUSED] = true;
    this[DISCARDED] = false;
  }
  /**
   * true if the stream has been forcibly destroyed
   */
  get destroyed() {
    return this[DESTROYED];
  }
  /**
   * true if the stream is currently in a flowing state, meaning that
   * any writes will be immediately emitted.
   */
  get flowing() {
    return this[FLOWING];
  }
  /**
   * true if the stream is currently in a paused state
   */
  get paused() {
    return this[PAUSED];
  }
  [BUFFERPUSH](chunk) {
    if (this[OBJECTMODE])
      this[BUFFERLENGTH] += 1;
    else
      this[BUFFERLENGTH] += chunk.length;
    this[BUFFER$1].push(chunk);
  }
  [BUFFERSHIFT]() {
    if (this[OBJECTMODE])
      this[BUFFERLENGTH] -= 1;
    else
      this[BUFFERLENGTH] -= this[BUFFER$1][0].length;
    return this[BUFFER$1].shift();
  }
  [FLUSH](noDrain = false) {
    do {
    } while (this[FLUSHCHUNK](this[BUFFERSHIFT]()) && this[BUFFER$1].length);
    if (!noDrain && !this[BUFFER$1].length && !this[EOF$1])
      this.emit("drain");
  }
  [FLUSHCHUNK](chunk) {
    this.emit("data", chunk);
    return this[FLOWING];
  }
  /**
   * Pipe all data emitted by this stream into the destination provided.
   *
   * Triggers the flow of data.
   */
  pipe(dest, opts) {
    if (this[DESTROYED])
      return dest;
    this[DISCARDED] = false;
    const ended = this[EMITTED_END];
    opts = opts || {};
    if (dest === proc.stdout || dest === proc.stderr)
      opts.end = false;
    else
      opts.end = opts.end !== false;
    opts.proxyErrors = !!opts.proxyErrors;
    if (ended) {
      if (opts.end)
        dest.end();
    } else {
      this[PIPES].push(!opts.proxyErrors ? new Pipe(this, dest, opts) : new PipeProxyErrors(this, dest, opts));
      if (this[ASYNC])
        defer(() => this[RESUME]());
      else
        this[RESUME]();
    }
    return dest;
  }
  /**
   * Fully unhook a piped destination stream.
   *
   * If the destination stream was the only consumer of this stream (ie,
   * there are no other piped destinations or `'data'` event listeners)
   * then the flow of data will stop until there is another consumer or
   * {@link Minipass#resume} is explicitly called.
   */
  unpipe(dest) {
    const p = this[PIPES].find((p2) => p2.dest === dest);
    if (p) {
      if (this[PIPES].length === 1) {
        if (this[FLOWING] && this[DATALISTENERS] === 0) {
          this[FLOWING] = false;
        }
        this[PIPES] = [];
      } else
        this[PIPES].splice(this[PIPES].indexOf(p), 1);
      p.unpipe();
    }
  }
  /**
   * Alias for {@link Minipass#on}
   */
  addListener(ev, handler) {
    return this.on(ev, handler);
  }
  /**
   * Mostly identical to `EventEmitter.on`, with the following
   * behavior differences to prevent data loss and unnecessary hangs:
   *
   * - Adding a 'data' event handler will trigger the flow of data
   *
   * - Adding a 'readable' event handler when there is data waiting to be read
   *   will cause 'readable' to be emitted immediately.
   *
   * - Adding an 'endish' event handler ('end', 'finish', etc.) which has
   *   already passed will cause the event to be emitted immediately and all
   *   handlers removed.
   *
   * - Adding an 'error' event handler after an error has been emitted will
   *   cause the event to be re-emitted immediately with the error previously
   *   raised.
   */
  on(ev, handler) {
    const ret = super.on(ev, handler);
    if (ev === "data") {
      this[DISCARDED] = false;
      this[DATALISTENERS]++;
      if (!this[PIPES].length && !this[FLOWING]) {
        this[RESUME]();
      }
    } else if (ev === "readable" && this[BUFFERLENGTH] !== 0) {
      super.emit("readable");
    } else if (isEndish(ev) && this[EMITTED_END]) {
      super.emit(ev);
      this.removeAllListeners(ev);
    } else if (ev === "error" && this[EMITTED_ERROR]) {
      const h = handler;
      if (this[ASYNC])
        defer(() => h.call(this, this[EMITTED_ERROR]));
      else
        h.call(this, this[EMITTED_ERROR]);
    }
    return ret;
  }
  /**
   * Alias for {@link Minipass#off}
   */
  removeListener(ev, handler) {
    return this.off(ev, handler);
  }
  /**
   * Mostly identical to `EventEmitter.off`
   *
   * If a 'data' event handler is removed, and it was the last consumer
   * (ie, there are no pipe destinations or other 'data' event listeners),
   * then the flow of data will stop until there is another consumer or
   * {@link Minipass#resume} is explicitly called.
   */
  off(ev, handler) {
    const ret = super.off(ev, handler);
    if (ev === "data") {
      this[DATALISTENERS] = this.listeners("data").length;
      if (this[DATALISTENERS] === 0 && !this[DISCARDED] && !this[PIPES].length) {
        this[FLOWING] = false;
      }
    }
    return ret;
  }
  /**
   * Mostly identical to `EventEmitter.removeAllListeners`
   *
   * If all 'data' event handlers are removed, and they were the last consumer
   * (ie, there are no pipe destinations), then the flow of data will stop
   * until there is another consumer or {@link Minipass#resume} is explicitly
   * called.
   */
  removeAllListeners(ev) {
    const ret = super.removeAllListeners(ev);
    if (ev === "data" || ev === void 0) {
      this[DATALISTENERS] = 0;
      if (!this[DISCARDED] && !this[PIPES].length) {
        this[FLOWING] = false;
      }
    }
    return ret;
  }
  /**
   * true if the 'end' event has been emitted
   */
  get emittedEnd() {
    return this[EMITTED_END];
  }
  [MAYBE_EMIT_END]() {
    if (!this[EMITTING_END] && !this[EMITTED_END] && !this[DESTROYED] && this[BUFFER$1].length === 0 && this[EOF$1]) {
      this[EMITTING_END] = true;
      this.emit("end");
      this.emit("prefinish");
      this.emit("finish");
      if (this[CLOSED])
        this.emit("close");
      this[EMITTING_END] = false;
    }
  }
  /**
   * Mostly identical to `EventEmitter.emit`, with the following
   * behavior differences to prevent data loss and unnecessary hangs:
   *
   * If the stream has been destroyed, and the event is something other
   * than 'close' or 'error', then `false` is returned and no handlers
   * are called.
   *
   * If the event is 'end', and has already been emitted, then the event
   * is ignored. If the stream is in a paused or non-flowing state, then
   * the event will be deferred until data flow resumes. If the stream is
   * async, then handlers will be called on the next tick rather than
   * immediately.
   *
   * If the event is 'close', and 'end' has not yet been emitted, then
   * the event will be deferred until after 'end' is emitted.
   *
   * If the event is 'error', and an AbortSignal was provided for the stream,
   * and there are no listeners, then the event is ignored, matching the
   * behavior of node core streams in the presense of an AbortSignal.
   *
   * If the event is 'finish' or 'prefinish', then all listeners will be
   * removed after emitting the event, to prevent double-firing.
   */
  emit(ev, ...args) {
    const data = args[0];
    if (ev !== "error" && ev !== "close" && ev !== DESTROYED && this[DESTROYED]) {
      return false;
    } else if (ev === "data") {
      return !this[OBJECTMODE] && !data ? false : this[ASYNC] ? (defer(() => this[EMITDATA](data)), true) : this[EMITDATA](data);
    } else if (ev === "end") {
      return this[EMITEND]();
    } else if (ev === "close") {
      this[CLOSED] = true;
      if (!this[EMITTED_END] && !this[DESTROYED])
        return false;
      const ret2 = super.emit("close");
      this.removeAllListeners("close");
      return ret2;
    } else if (ev === "error") {
      this[EMITTED_ERROR] = data;
      super.emit(ERROR, data);
      const ret2 = !this[SIGNAL] || this.listeners("error").length ? super.emit("error", data) : false;
      this[MAYBE_EMIT_END]();
      return ret2;
    } else if (ev === "resume") {
      const ret2 = super.emit("resume");
      this[MAYBE_EMIT_END]();
      return ret2;
    } else if (ev === "finish" || ev === "prefinish") {
      const ret2 = super.emit(ev);
      this.removeAllListeners(ev);
      return ret2;
    }
    const ret = super.emit(ev, ...args);
    this[MAYBE_EMIT_END]();
    return ret;
  }
  [EMITDATA](data) {
    for (const p of this[PIPES]) {
      if (p.dest.write(data) === false)
        this.pause();
    }
    const ret = this[DISCARDED] ? false : super.emit("data", data);
    this[MAYBE_EMIT_END]();
    return ret;
  }
  [EMITEND]() {
    if (this[EMITTED_END])
      return false;
    this[EMITTED_END] = true;
    this.readable = false;
    return this[ASYNC] ? (defer(() => this[EMITEND2]()), true) : this[EMITEND2]();
  }
  [EMITEND2]() {
    if (this[DECODER]) {
      const data = this[DECODER].end();
      if (data) {
        for (const p of this[PIPES]) {
          p.dest.write(data);
        }
        if (!this[DISCARDED])
          super.emit("data", data);
      }
    }
    for (const p of this[PIPES]) {
      p.end();
    }
    const ret = super.emit("end");
    this.removeAllListeners("end");
    return ret;
  }
  /**
   * Return a Promise that resolves to an array of all emitted data once
   * the stream ends.
   */
  async collect() {
    const buf = Object.assign([], {
      dataLength: 0
    });
    if (!this[OBJECTMODE])
      buf.dataLength = 0;
    const p = this.promise();
    this.on("data", (c) => {
      buf.push(c);
      if (!this[OBJECTMODE])
        buf.dataLength += c.length;
    });
    await p;
    return buf;
  }
  /**
   * Return a Promise that resolves to the concatenation of all emitted data
   * once the stream ends.
   *
   * Not allowed on objectMode streams.
   */
  async concat() {
    if (this[OBJECTMODE]) {
      throw new Error("cannot concat in objectMode");
    }
    const buf = await this.collect();
    return this[ENCODING] ? buf.join("") : Buffer.concat(buf, buf.dataLength);
  }
  /**
   * Return a void Promise that resolves once the stream ends.
   */
  async promise() {
    return new Promise((resolve2, reject) => {
      this.on(DESTROYED, () => reject(new Error("stream destroyed")));
      this.on("error", (er) => reject(er));
      this.on("end", () => resolve2());
    });
  }
  /**
   * Asynchronous `for await of` iteration.
   *
   * This will continue emitting all chunks until the stream terminates.
   */
  [Symbol.asyncIterator]() {
    this[DISCARDED] = false;
    let stopped = false;
    const stop = async () => {
      this.pause();
      stopped = true;
      return { value: void 0, done: true };
    };
    const next = () => {
      if (stopped)
        return stop();
      const res = this.read();
      if (res !== null)
        return Promise.resolve({ done: false, value: res });
      if (this[EOF$1])
        return stop();
      let resolve2;
      let reject;
      const onerr = (er) => {
        this.off("data", ondata);
        this.off("end", onend);
        this.off(DESTROYED, ondestroy);
        stop();
        reject(er);
      };
      const ondata = (value) => {
        this.off("error", onerr);
        this.off("end", onend);
        this.off(DESTROYED, ondestroy);
        this.pause();
        resolve2({ value, done: !!this[EOF$1] });
      };
      const onend = () => {
        this.off("error", onerr);
        this.off("data", ondata);
        this.off(DESTROYED, ondestroy);
        stop();
        resolve2({ done: true, value: void 0 });
      };
      const ondestroy = () => onerr(new Error("stream destroyed"));
      return new Promise((res2, rej) => {
        reject = rej;
        resolve2 = res2;
        this.once(DESTROYED, ondestroy);
        this.once("error", onerr);
        this.once("end", onend);
        this.once("data", ondata);
      });
    };
    return {
      next,
      throw: stop,
      return: stop,
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }
  /**
   * Synchronous `for of` iteration.
   *
   * The iteration will terminate when the internal buffer runs out, even
   * if the stream has not yet terminated.
   */
  [Symbol.iterator]() {
    this[DISCARDED] = false;
    let stopped = false;
    const stop = () => {
      this.pause();
      this.off(ERROR, stop);
      this.off(DESTROYED, stop);
      this.off("end", stop);
      stopped = true;
      return { done: true, value: void 0 };
    };
    const next = () => {
      if (stopped)
        return stop();
      const value = this.read();
      return value === null ? stop() : { done: false, value };
    };
    this.once("end", stop);
    this.once(ERROR, stop);
    this.once(DESTROYED, stop);
    return {
      next,
      throw: stop,
      return: stop,
      [Symbol.iterator]() {
        return this;
      }
    };
  }
  /**
   * Destroy a stream, preventing it from being used for any further purpose.
   *
   * If the stream has a `close()` method, then it will be called on
   * destruction.
   *
   * After destruction, any attempt to write data, read data, or emit most
   * events will be ignored.
   *
   * If an error argument is provided, then it will be emitted in an
   * 'error' event.
   */
  destroy(er) {
    if (this[DESTROYED]) {
      if (er)
        this.emit("error", er);
      else
        this.emit(DESTROYED);
      return this;
    }
    this[DESTROYED] = true;
    this[DISCARDED] = true;
    this[BUFFER$1].length = 0;
    this[BUFFERLENGTH] = 0;
    const wc = this;
    if (typeof wc.close === "function" && !this[CLOSED])
      wc.close();
    if (er)
      this.emit("error", er);
    else
      this.emit(DESTROYED);
    return this;
  }
  /**
   * Alias for {@link isStream}
   *
   * Former export location, maintained for backwards compatibility.
   *
   * @deprecated
   */
  static get isStream() {
    return isStream;
  }
}
const writev = fs.writev;
const _autoClose = Symbol("_autoClose");
const _close = Symbol("_close");
const _ended = Symbol("_ended");
const _fd = Symbol("_fd");
const _finished = Symbol("_finished");
const _flags = Symbol("_flags");
const _flush = Symbol("_flush");
const _handleChunk = Symbol("_handleChunk");
const _makeBuf = Symbol("_makeBuf");
const _mode = Symbol("_mode");
const _needDrain = Symbol("_needDrain");
const _onerror = Symbol("_onerror");
const _onopen = Symbol("_onopen");
const _onread = Symbol("_onread");
const _onwrite = Symbol("_onwrite");
const _open = Symbol("_open");
const _path = Symbol("_path");
const _pos = Symbol("_pos");
const _queue = Symbol("_queue");
const _read = Symbol("_read");
const _readSize = Symbol("_readSize");
const _reading = Symbol("_reading");
const _remain = Symbol("_remain");
const _size = Symbol("_size");
const _write = Symbol("_write");
const _writing = Symbol("_writing");
const _defaultFlag = Symbol("_defaultFlag");
const _errored = Symbol("_errored");
class ReadStream extends Minipass {
  [_errored] = false;
  [_fd];
  [_path];
  [_readSize];
  [_reading] = false;
  [_size];
  [_remain];
  [_autoClose];
  constructor(path, opt) {
    opt = opt || {};
    super(opt);
    this.readable = true;
    this.writable = false;
    if (typeof path !== "string") {
      throw new TypeError("path must be a string");
    }
    this[_errored] = false;
    this[_fd] = typeof opt.fd === "number" ? opt.fd : void 0;
    this[_path] = path;
    this[_readSize] = opt.readSize || 16 * 1024 * 1024;
    this[_reading] = false;
    this[_size] = typeof opt.size === "number" ? opt.size : Infinity;
    this[_remain] = this[_size];
    this[_autoClose] = typeof opt.autoClose === "boolean" ? opt.autoClose : true;
    if (typeof this[_fd] === "number") {
      this[_read]();
    } else {
      this[_open]();
    }
  }
  get fd() {
    return this[_fd];
  }
  get path() {
    return this[_path];
  }
  //@ts-ignore
  write() {
    throw new TypeError("this is a readable stream");
  }
  //@ts-ignore
  end() {
    throw new TypeError("this is a readable stream");
  }
  [_open]() {
    fs.open(this[_path], "r", (er, fd) => this[_onopen](er, fd));
  }
  [_onopen](er, fd) {
    if (er) {
      this[_onerror](er);
    } else {
      this[_fd] = fd;
      this.emit("open", fd);
      this[_read]();
    }
  }
  [_makeBuf]() {
    return Buffer.allocUnsafe(Math.min(this[_readSize], this[_remain]));
  }
  [_read]() {
    if (!this[_reading]) {
      this[_reading] = true;
      const buf = this[_makeBuf]();
      if (buf.length === 0) {
        return process.nextTick(() => this[_onread](null, 0, buf));
      }
      fs.read(this[_fd], buf, 0, buf.length, null, (er, br, b) => this[_onread](er, br, b));
    }
  }
  [_onread](er, br, buf) {
    this[_reading] = false;
    if (er) {
      this[_onerror](er);
    } else if (this[_handleChunk](br, buf)) {
      this[_read]();
    }
  }
  [_close]() {
    if (this[_autoClose] && typeof this[_fd] === "number") {
      const fd = this[_fd];
      this[_fd] = void 0;
      fs.close(fd, (er) => er ? this.emit("error", er) : this.emit("close"));
    }
  }
  [_onerror](er) {
    this[_reading] = true;
    this[_close]();
    this.emit("error", er);
  }
  [_handleChunk](br, buf) {
    let ret = false;
    this[_remain] -= br;
    if (br > 0) {
      ret = super.write(br < buf.length ? buf.subarray(0, br) : buf);
    }
    if (br === 0 || this[_remain] <= 0) {
      ret = false;
      this[_close]();
      super.end();
    }
    return ret;
  }
  emit(ev, ...args) {
    switch (ev) {
      case "prefinish":
      case "finish":
        return false;
      case "drain":
        if (typeof this[_fd] === "number") {
          this[_read]();
        }
        return false;
      case "error":
        if (this[_errored]) {
          return false;
        }
        this[_errored] = true;
        return super.emit(ev, ...args);
      default:
        return super.emit(ev, ...args);
    }
  }
}
class ReadStreamSync extends ReadStream {
  [_open]() {
    let threw = true;
    try {
      this[_onopen](null, fs.openSync(this[_path], "r"));
      threw = false;
    } finally {
      if (threw) {
        this[_close]();
      }
    }
  }
  [_read]() {
    let threw = true;
    try {
      if (!this[_reading]) {
        this[_reading] = true;
        do {
          const buf = this[_makeBuf]();
          const br = buf.length === 0 ? 0 : fs.readSync(this[_fd], buf, 0, buf.length, null);
          if (!this[_handleChunk](br, buf)) {
            break;
          }
        } while (true);
        this[_reading] = false;
      }
      threw = false;
    } finally {
      if (threw) {
        this[_close]();
      }
    }
  }
  [_close]() {
    if (this[_autoClose] && typeof this[_fd] === "number") {
      const fd = this[_fd];
      this[_fd] = void 0;
      fs.closeSync(fd);
      this.emit("close");
    }
  }
}
class WriteStream extends EE {
  readable = false;
  writable = true;
  [_errored] = false;
  [_writing] = false;
  [_ended] = false;
  [_queue] = [];
  [_needDrain] = false;
  [_path];
  [_mode];
  [_autoClose];
  [_fd];
  [_defaultFlag];
  [_flags];
  [_finished] = false;
  [_pos];
  constructor(path, opt) {
    opt = opt || {};
    super(opt);
    this[_path] = path;
    this[_fd] = typeof opt.fd === "number" ? opt.fd : void 0;
    this[_mode] = opt.mode === void 0 ? 438 : opt.mode;
    this[_pos] = typeof opt.start === "number" ? opt.start : void 0;
    this[_autoClose] = typeof opt.autoClose === "boolean" ? opt.autoClose : true;
    const defaultFlag = this[_pos] !== void 0 ? "r+" : "w";
    this[_defaultFlag] = opt.flags === void 0;
    this[_flags] = opt.flags === void 0 ? defaultFlag : opt.flags;
    if (this[_fd] === void 0) {
      this[_open]();
    }
  }
  emit(ev, ...args) {
    if (ev === "error") {
      if (this[_errored]) {
        return false;
      }
      this[_errored] = true;
    }
    return super.emit(ev, ...args);
  }
  get fd() {
    return this[_fd];
  }
  get path() {
    return this[_path];
  }
  [_onerror](er) {
    this[_close]();
    this[_writing] = true;
    this.emit("error", er);
  }
  [_open]() {
    fs.open(this[_path], this[_flags], this[_mode], (er, fd) => this[_onopen](er, fd));
  }
  [_onopen](er, fd) {
    if (this[_defaultFlag] && this[_flags] === "r+" && er && er.code === "ENOENT") {
      this[_flags] = "w";
      this[_open]();
    } else if (er) {
      this[_onerror](er);
    } else {
      this[_fd] = fd;
      this.emit("open", fd);
      if (!this[_writing]) {
        this[_flush]();
      }
    }
  }
  end(buf, enc) {
    if (buf) {
      this.write(buf, enc);
    }
    this[_ended] = true;
    if (!this[_writing] && !this[_queue].length && typeof this[_fd] === "number") {
      this[_onwrite](null, 0);
    }
    return this;
  }
  write(buf, enc) {
    if (typeof buf === "string") {
      buf = Buffer.from(buf, enc);
    }
    if (this[_ended]) {
      this.emit("error", new Error("write() after end()"));
      return false;
    }
    if (this[_fd] === void 0 || this[_writing] || this[_queue].length) {
      this[_queue].push(buf);
      this[_needDrain] = true;
      return false;
    }
    this[_writing] = true;
    this[_write](buf);
    return true;
  }
  [_write](buf) {
    fs.write(this[_fd], buf, 0, buf.length, this[_pos], (er, bw) => this[_onwrite](er, bw));
  }
  [_onwrite](er, bw) {
    if (er) {
      this[_onerror](er);
    } else {
      if (this[_pos] !== void 0 && typeof bw === "number") {
        this[_pos] += bw;
      }
      if (this[_queue].length) {
        this[_flush]();
      } else {
        this[_writing] = false;
        if (this[_ended] && !this[_finished]) {
          this[_finished] = true;
          this[_close]();
          this.emit("finish");
        } else if (this[_needDrain]) {
          this[_needDrain] = false;
          this.emit("drain");
        }
      }
    }
  }
  [_flush]() {
    if (this[_queue].length === 0) {
      if (this[_ended]) {
        this[_onwrite](null, 0);
      }
    } else if (this[_queue].length === 1) {
      this[_write](this[_queue].pop());
    } else {
      const iovec = this[_queue];
      this[_queue] = [];
      writev(this[_fd], iovec, this[_pos], (er, bw) => this[_onwrite](er, bw));
    }
  }
  [_close]() {
    if (this[_autoClose] && typeof this[_fd] === "number") {
      const fd = this[_fd];
      this[_fd] = void 0;
      fs.close(fd, (er) => er ? this.emit("error", er) : this.emit("close"));
    }
  }
}
class WriteStreamSync extends WriteStream {
  [_open]() {
    let fd;
    if (this[_defaultFlag] && this[_flags] === "r+") {
      try {
        fd = fs.openSync(this[_path], this[_flags], this[_mode]);
      } catch (er) {
        if (er?.code === "ENOENT") {
          this[_flags] = "w";
          return this[_open]();
        } else {
          throw er;
        }
      }
    } else {
      fd = fs.openSync(this[_path], this[_flags], this[_mode]);
    }
    this[_onopen](null, fd);
  }
  [_close]() {
    if (this[_autoClose] && typeof this[_fd] === "number") {
      const fd = this[_fd];
      this[_fd] = void 0;
      fs.closeSync(fd);
      this.emit("close");
    }
  }
  [_write](buf) {
    let threw = true;
    try {
      this[_onwrite](null, fs.writeSync(this[_fd], buf, 0, buf.length, this[_pos]));
      threw = false;
    } finally {
      if (threw) {
        try {
          this[_close]();
        } catch {
        }
      }
    }
  }
}
const argmap = /* @__PURE__ */ new Map([
  ["C", "cwd"],
  ["f", "file"],
  ["z", "gzip"],
  ["P", "preservePaths"],
  ["U", "unlink"],
  ["strip-components", "strip"],
  ["stripComponents", "strip"],
  ["keep-newer", "newer"],
  ["keepNewer", "newer"],
  ["keep-newer-files", "newer"],
  ["keepNewerFiles", "newer"],
  ["k", "keep"],
  ["keep-existing", "keep"],
  ["keepExisting", "keep"],
  ["m", "noMtime"],
  ["no-mtime", "noMtime"],
  ["p", "preserveOwner"],
  ["L", "follow"],
  ["h", "follow"],
  ["onentry", "onReadEntry"]
]);
const isSyncFile = (o) => !!o.sync && !!o.file;
const isAsyncFile = (o) => !o.sync && !!o.file;
const isSyncNoFile = (o) => !!o.sync && !o.file;
const isAsyncNoFile = (o) => !o.sync && !o.file;
const isFile = (o) => !!o.file;
const dealiasKey = (k) => {
  const d = argmap.get(k);
  if (d)
    return d;
  return k;
};
const dealias = (opt = {}) => {
  if (!opt)
    return {};
  const result = {};
  for (const [key, v] of Object.entries(opt)) {
    const k = dealiasKey(key);
    result[k] = v;
  }
  if (result.chmod === void 0 && result.noChmod === false) {
    result.chmod = true;
  }
  delete result.noChmod;
  return result;
};
const makeCommand = (syncFile, asyncFile, syncNoFile, asyncNoFile, validate) => {
  return Object.assign((opt_ = [], entries, cb) => {
    if (Array.isArray(opt_)) {
      entries = opt_;
      opt_ = {};
    }
    if (typeof entries === "function") {
      cb = entries;
      entries = void 0;
    }
    if (!entries) {
      entries = [];
    } else {
      entries = Array.from(entries);
    }
    const opt = dealias(opt_);
    validate?.(opt, entries);
    if (isSyncFile(opt)) {
      if (typeof cb === "function") {
        throw new TypeError("callback not supported for sync tar functions");
      }
      return syncFile(opt, entries);
    } else if (isAsyncFile(opt)) {
      const p = asyncFile(opt, entries);
      const c = cb ? cb : void 0;
      return c ? p.then(() => c(), c) : p;
    } else if (isSyncNoFile(opt)) {
      if (typeof cb === "function") {
        throw new TypeError("callback not supported for sync tar functions");
      }
      return syncNoFile(opt, entries);
    } else if (isAsyncNoFile(opt)) {
      if (typeof cb === "function") {
        throw new TypeError("callback only supported with file option");
      }
      return asyncNoFile(opt, entries);
    } else {
      throw new Error("impossible options??");
    }
  }, {
    syncFile,
    asyncFile,
    syncNoFile,
    asyncNoFile,
    validate
  });
};
const realZlibConstants = realZlib__default.constants || { ZLIB_VERNUM: 4736 };
const constants = Object.freeze(Object.assign(/* @__PURE__ */ Object.create(null), {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31
}, realZlibConstants));
const OriginalBufferConcat = Buffer$1.concat;
const desc = Object.getOwnPropertyDescriptor(Buffer$1, "concat");
const noop$1 = (args) => args;
const passthroughBufferConcat = desc?.writable === true || desc?.set !== void 0 ? (makeNoOp) => {
  Buffer$1.concat = makeNoOp ? noop$1 : OriginalBufferConcat;
} : (_) => {
};
const _superWrite = Symbol("_superWrite");
class ZlibError extends Error {
  code;
  errno;
  constructor(err, origin) {
    super("zlib: " + err.message, { cause: err });
    this.code = err.code;
    this.errno = err.errno;
    if (!this.code)
      this.code = "ZLIB_ERROR";
    this.message = "zlib: " + err.message;
    Error.captureStackTrace(this, origin ?? this.constructor);
  }
  get name() {
    return "ZlibError";
  }
}
const _flushFlag = Symbol("flushFlag");
class ZlibBase extends Minipass {
  #sawError = false;
  #ended = false;
  #flushFlag;
  #finishFlushFlag;
  #fullFlushFlag;
  #handle;
  #onError;
  get sawError() {
    return this.#sawError;
  }
  get handle() {
    return this.#handle;
  }
  /* c8 ignore start */
  get flushFlag() {
    return this.#flushFlag;
  }
  /* c8 ignore stop */
  constructor(opts, mode) {
    if (!opts || typeof opts !== "object")
      throw new TypeError("invalid options for ZlibBase constructor");
    super(opts);
    this.#flushFlag = opts.flush ?? 0;
    this.#finishFlushFlag = opts.finishFlush ?? 0;
    this.#fullFlushFlag = opts.fullFlushFlag ?? 0;
    if (typeof realZlib[mode] !== "function") {
      throw new TypeError("Compression method not supported: " + mode);
    }
    try {
      this.#handle = new realZlib[mode](opts);
    } catch (er) {
      throw new ZlibError(er, this.constructor);
    }
    this.#onError = (err) => {
      if (this.#sawError)
        return;
      this.#sawError = true;
      this.close();
      this.emit("error", err);
    };
    this.#handle?.on("error", (er) => this.#onError(new ZlibError(er)));
    this.once("end", () => this.close);
  }
  close() {
    if (this.#handle) {
      this.#handle.close();
      this.#handle = void 0;
      this.emit("close");
    }
  }
  reset() {
    if (!this.#sawError) {
      assert(this.#handle, "zlib binding closed");
      return this.#handle.reset?.();
    }
  }
  flush(flushFlag) {
    if (this.ended)
      return;
    if (typeof flushFlag !== "number")
      flushFlag = this.#fullFlushFlag;
    this.write(Object.assign(Buffer$1.alloc(0), { [_flushFlag]: flushFlag }));
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      encoding = void 0;
      chunk = void 0;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (chunk) {
      if (encoding)
        this.write(chunk, encoding);
      else
        this.write(chunk);
    }
    this.flush(this.#finishFlushFlag);
    this.#ended = true;
    return super.end(cb);
  }
  get ended() {
    return this.#ended;
  }
  // overridden in the gzip classes to do portable writes
  [_superWrite](data) {
    return super.write(data);
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function")
      cb = encoding, encoding = "utf8";
    if (typeof chunk === "string")
      chunk = Buffer$1.from(chunk, encoding);
    if (this.#sawError)
      return;
    assert(this.#handle, "zlib binding closed");
    const nativeHandle = this.#handle._handle;
    const originalNativeClose = nativeHandle.close;
    nativeHandle.close = () => {
    };
    const originalClose = this.#handle.close;
    this.#handle.close = () => {
    };
    passthroughBufferConcat(true);
    let result = void 0;
    try {
      const flushFlag = typeof chunk[_flushFlag] === "number" ? chunk[_flushFlag] : this.#flushFlag;
      result = this.#handle._processChunk(chunk, flushFlag);
      passthroughBufferConcat(false);
    } catch (err) {
      passthroughBufferConcat(false);
      this.#onError(new ZlibError(err, this.write));
    } finally {
      if (this.#handle) {
        this.#handle._handle = nativeHandle;
        nativeHandle.close = originalNativeClose;
        this.#handle.close = originalClose;
        this.#handle.removeAllListeners("error");
      }
    }
    if (this.#handle)
      this.#handle.on("error", (er) => this.#onError(new ZlibError(er, this.write)));
    let writeReturn;
    if (result) {
      if (Array.isArray(result) && result.length > 0) {
        const r = result[0];
        writeReturn = this[_superWrite](Buffer$1.from(r));
        for (let i = 1; i < result.length; i++) {
          writeReturn = this[_superWrite](result[i]);
        }
      } else {
        writeReturn = this[_superWrite](Buffer$1.from(result));
      }
    }
    if (cb)
      cb();
    return writeReturn;
  }
}
class Zlib extends ZlibBase {
  #level;
  #strategy;
  constructor(opts, mode) {
    opts = opts || {};
    opts.flush = opts.flush || constants.Z_NO_FLUSH;
    opts.finishFlush = opts.finishFlush || constants.Z_FINISH;
    opts.fullFlushFlag = constants.Z_FULL_FLUSH;
    super(opts, mode);
    this.#level = opts.level;
    this.#strategy = opts.strategy;
  }
  params(level, strategy) {
    if (this.sawError)
      return;
    if (!this.handle)
      throw new Error("cannot switch params when binding is closed");
    if (!this.handle.params)
      throw new Error("not supported in this implementation");
    if (this.#level !== level || this.#strategy !== strategy) {
      this.flush(constants.Z_SYNC_FLUSH);
      assert(this.handle, "zlib binding closed");
      const origFlush = this.handle.flush;
      this.handle.flush = (flushFlag, cb) => {
        if (typeof flushFlag === "function") {
          cb = flushFlag;
          flushFlag = this.flushFlag;
        }
        this.flush(flushFlag);
        cb?.();
      };
      try {
        ;
        this.handle.params(level, strategy);
      } finally {
        this.handle.flush = origFlush;
      }
      if (this.handle) {
        this.#level = level;
        this.#strategy = strategy;
      }
    }
  }
}
class Gzip extends Zlib {
  #portable;
  constructor(opts) {
    super(opts, "Gzip");
    this.#portable = opts && !!opts.portable;
  }
  [_superWrite](data) {
    if (!this.#portable)
      return super[_superWrite](data);
    this.#portable = false;
    data[9] = 255;
    return super[_superWrite](data);
  }
}
class Unzip extends Zlib {
  constructor(opts) {
    super(opts, "Unzip");
  }
}
class Brotli extends ZlibBase {
  constructor(opts, mode) {
    opts = opts || {};
    opts.flush = opts.flush || constants.BROTLI_OPERATION_PROCESS;
    opts.finishFlush = opts.finishFlush || constants.BROTLI_OPERATION_FINISH;
    opts.fullFlushFlag = constants.BROTLI_OPERATION_FLUSH;
    super(opts, mode);
  }
}
class BrotliCompress extends Brotli {
  constructor(opts) {
    super(opts, "BrotliCompress");
  }
}
class BrotliDecompress extends Brotli {
  constructor(opts) {
    super(opts, "BrotliDecompress");
  }
}
class Zstd extends ZlibBase {
  constructor(opts, mode) {
    opts = opts || {};
    opts.flush = opts.flush || constants.ZSTD_e_continue;
    opts.finishFlush = opts.finishFlush || constants.ZSTD_e_end;
    opts.fullFlushFlag = constants.ZSTD_e_flush;
    super(opts, mode);
  }
}
class ZstdCompress extends Zstd {
  constructor(opts) {
    super(opts, "ZstdCompress");
  }
}
class ZstdDecompress extends Zstd {
  constructor(opts) {
    super(opts, "ZstdDecompress");
  }
}
const encode$1 = (num, buf) => {
  if (!Number.isSafeInteger(num)) {
    throw Error("cannot encode number outside of javascript safe integer range");
  } else if (num < 0) {
    encodeNegative(num, buf);
  } else {
    encodePositive(num, buf);
  }
  return buf;
};
const encodePositive = (num, buf) => {
  buf[0] = 128;
  for (var i = buf.length; i > 1; i--) {
    buf[i - 1] = num & 255;
    num = Math.floor(num / 256);
  }
};
const encodeNegative = (num, buf) => {
  buf[0] = 255;
  var flipped = false;
  num = num * -1;
  for (var i = buf.length; i > 1; i--) {
    var byte = num & 255;
    num = Math.floor(num / 256);
    if (flipped) {
      buf[i - 1] = onesComp(byte);
    } else if (byte === 0) {
      buf[i - 1] = 0;
    } else {
      flipped = true;
      buf[i - 1] = twosComp(byte);
    }
  }
};
const parse$1 = (buf) => {
  const pre = buf[0];
  const value = pre === 128 ? pos(buf.subarray(1, buf.length)) : pre === 255 ? twos(buf) : null;
  if (value === null) {
    throw Error("invalid base256 encoding");
  }
  if (!Number.isSafeInteger(value)) {
    throw Error("parsed number outside of javascript safe integer range");
  }
  return value;
};
const twos = (buf) => {
  var len = buf.length;
  var sum = 0;
  var flipped = false;
  for (var i = len - 1; i > -1; i--) {
    var byte = Number(buf[i]);
    var f;
    if (flipped) {
      f = onesComp(byte);
    } else if (byte === 0) {
      f = byte;
    } else {
      flipped = true;
      f = twosComp(byte);
    }
    if (f !== 0) {
      sum -= f * Math.pow(256, len - i - 1);
    }
  }
  return sum;
};
const pos = (buf) => {
  var len = buf.length;
  var sum = 0;
  for (var i = len - 1; i > -1; i--) {
    var byte = Number(buf[i]);
    if (byte !== 0) {
      sum += byte * Math.pow(256, len - i - 1);
    }
  }
  return sum;
};
const onesComp = (byte) => (255 ^ byte) & 255;
const twosComp = (byte) => (255 ^ byte) + 1 & 255;
const isCode = (c) => name.has(c);
const name = /* @__PURE__ */ new Map([
  ["0", "File"],
  // same as File
  ["", "OldFile"],
  ["1", "Link"],
  ["2", "SymbolicLink"],
  // Devices and FIFOs aren't fully supported
  // they are parsed, but skipped when unpacking
  ["3", "CharacterDevice"],
  ["4", "BlockDevice"],
  ["5", "Directory"],
  ["6", "FIFO"],
  // same as File
  ["7", "ContiguousFile"],
  // pax headers
  ["g", "GlobalExtendedHeader"],
  ["x", "ExtendedHeader"],
  // vendor-specific stuff
  // skip
  ["A", "SolarisACL"],
  // like 5, but with data, which should be skipped
  ["D", "GNUDumpDir"],
  // metadata only, skip
  ["I", "Inode"],
  // data = link path of next file
  ["K", "NextFileHasLongLinkpath"],
  // data = path of next file
  ["L", "NextFileHasLongPath"],
  // skip
  ["M", "ContinuationFile"],
  // like L
  ["N", "OldGnuLongPath"],
  // skip
  ["S", "SparseFile"],
  // skip
  ["V", "TapeVolumeHeader"],
  // like x
  ["X", "OldExtendedHeader"]
]);
const code = new Map(Array.from(name).map((kv) => [kv[1], kv[0]]));
class Header {
  cksumValid = false;
  needPax = false;
  nullBlock = false;
  block;
  path;
  mode;
  uid;
  gid;
  size;
  cksum;
  #type = "Unsupported";
  linkpath;
  uname;
  gname;
  devmaj = 0;
  devmin = 0;
  atime;
  ctime;
  mtime;
  charset;
  comment;
  constructor(data, off = 0, ex, gex) {
    if (Buffer.isBuffer(data)) {
      this.decode(data, off || 0, ex, gex);
    } else if (data) {
      this.#slurp(data);
    }
  }
  decode(buf, off, ex, gex) {
    if (!off) {
      off = 0;
    }
    if (!buf || !(buf.length >= off + 512)) {
      throw new Error("need 512 bytes for header");
    }
    this.path = decString(buf, off, 100);
    this.mode = decNumber(buf, off + 100, 8);
    this.uid = decNumber(buf, off + 108, 8);
    this.gid = decNumber(buf, off + 116, 8);
    this.size = decNumber(buf, off + 124, 12);
    this.mtime = decDate(buf, off + 136, 12);
    this.cksum = decNumber(buf, off + 148, 12);
    if (gex)
      this.#slurp(gex, true);
    if (ex)
      this.#slurp(ex);
    const t = decString(buf, off + 156, 1);
    if (isCode(t)) {
      this.#type = t || "0";
    }
    if (this.#type === "0" && this.path.slice(-1) === "/") {
      this.#type = "5";
    }
    if (this.#type === "5") {
      this.size = 0;
    }
    this.linkpath = decString(buf, off + 157, 100);
    if (buf.subarray(off + 257, off + 265).toString() === "ustar\x0000") {
      this.uname = decString(buf, off + 265, 32);
      this.gname = decString(buf, off + 297, 32);
      this.devmaj = decNumber(buf, off + 329, 8) ?? 0;
      this.devmin = decNumber(buf, off + 337, 8) ?? 0;
      if (buf[off + 475] !== 0) {
        const prefix = decString(buf, off + 345, 155);
        this.path = prefix + "/" + this.path;
      } else {
        const prefix = decString(buf, off + 345, 130);
        if (prefix) {
          this.path = prefix + "/" + this.path;
        }
        this.atime = decDate(buf, off + 476, 12);
        this.ctime = decDate(buf, off + 488, 12);
      }
    }
    let sum = 8 * 32;
    for (let i = off; i < off + 148; i++) {
      sum += buf[i];
    }
    for (let i = off + 156; i < off + 512; i++) {
      sum += buf[i];
    }
    this.cksumValid = sum === this.cksum;
    if (this.cksum === void 0 && sum === 8 * 32) {
      this.nullBlock = true;
    }
  }
  #slurp(ex, gex = false) {
    Object.assign(this, Object.fromEntries(Object.entries(ex).filter(([k, v]) => {
      return !(v === null || v === void 0 || k === "path" && gex || k === "linkpath" && gex || k === "global");
    })));
  }
  encode(buf, off = 0) {
    if (!buf) {
      buf = this.block = Buffer.alloc(512);
    }
    if (this.#type === "Unsupported") {
      this.#type = "0";
    }
    if (!(buf.length >= off + 512)) {
      throw new Error("need 512 bytes for header");
    }
    const prefixSize = this.ctime || this.atime ? 130 : 155;
    const split = splitPrefix(this.path || "", prefixSize);
    const path = split[0];
    const prefix = split[1];
    this.needPax = !!split[2];
    this.needPax = encString(buf, off, 100, path) || this.needPax;
    this.needPax = encNumber(buf, off + 100, 8, this.mode) || this.needPax;
    this.needPax = encNumber(buf, off + 108, 8, this.uid) || this.needPax;
    this.needPax = encNumber(buf, off + 116, 8, this.gid) || this.needPax;
    this.needPax = encNumber(buf, off + 124, 12, this.size) || this.needPax;
    this.needPax = encDate(buf, off + 136, 12, this.mtime) || this.needPax;
    buf[off + 156] = this.#type.charCodeAt(0);
    this.needPax = encString(buf, off + 157, 100, this.linkpath) || this.needPax;
    buf.write("ustar\x0000", off + 257, 8);
    this.needPax = encString(buf, off + 265, 32, this.uname) || this.needPax;
    this.needPax = encString(buf, off + 297, 32, this.gname) || this.needPax;
    this.needPax = encNumber(buf, off + 329, 8, this.devmaj) || this.needPax;
    this.needPax = encNumber(buf, off + 337, 8, this.devmin) || this.needPax;
    this.needPax = encString(buf, off + 345, prefixSize, prefix) || this.needPax;
    if (buf[off + 475] !== 0) {
      this.needPax = encString(buf, off + 345, 155, prefix) || this.needPax;
    } else {
      this.needPax = encString(buf, off + 345, 130, prefix) || this.needPax;
      this.needPax = encDate(buf, off + 476, 12, this.atime) || this.needPax;
      this.needPax = encDate(buf, off + 488, 12, this.ctime) || this.needPax;
    }
    let sum = 8 * 32;
    for (let i = off; i < off + 148; i++) {
      sum += buf[i];
    }
    for (let i = off + 156; i < off + 512; i++) {
      sum += buf[i];
    }
    this.cksum = sum;
    encNumber(buf, off + 148, 8, this.cksum);
    this.cksumValid = true;
    return this.needPax;
  }
  get type() {
    return this.#type === "Unsupported" ? this.#type : name.get(this.#type);
  }
  get typeKey() {
    return this.#type;
  }
  set type(type) {
    const c = String(code.get(type));
    if (isCode(c) || c === "Unsupported") {
      this.#type = c;
    } else if (isCode(type)) {
      this.#type = type;
    } else {
      throw new TypeError("invalid entry type: " + type);
    }
  }
}
const splitPrefix = (p, prefixSize) => {
  const pathSize = 100;
  let pp = p;
  let prefix = "";
  let ret = void 0;
  const root = posix.parse(p).root || ".";
  if (Buffer.byteLength(pp) < pathSize) {
    ret = [pp, prefix, false];
  } else {
    prefix = posix.dirname(pp);
    pp = posix.basename(pp);
    do {
      if (Buffer.byteLength(pp) <= pathSize && Buffer.byteLength(prefix) <= prefixSize) {
        ret = [pp, prefix, false];
      } else if (Buffer.byteLength(pp) > pathSize && Buffer.byteLength(prefix) <= prefixSize) {
        ret = [pp.slice(0, pathSize - 1), prefix, true];
      } else {
        pp = posix.join(posix.basename(prefix), pp);
        prefix = posix.dirname(prefix);
      }
    } while (prefix !== root && ret === void 0);
    if (!ret) {
      ret = [p.slice(0, pathSize - 1), "", true];
    }
  }
  return ret;
};
const decString = (buf, off, size) => buf.subarray(off, off + size).toString("utf8").replace(/\0.*/, "");
const decDate = (buf, off, size) => numToDate(decNumber(buf, off, size));
const numToDate = (num) => num === void 0 ? void 0 : new Date(num * 1e3);
const decNumber = (buf, off, size) => Number(buf[off]) & 128 ? parse$1(buf.subarray(off, off + size)) : decSmallNumber(buf, off, size);
const nanUndef = (value) => isNaN(value) ? void 0 : value;
const decSmallNumber = (buf, off, size) => nanUndef(parseInt(buf.subarray(off, off + size).toString("utf8").replace(/\0.*$/, "").trim(), 8));
const MAXNUM = {
  12: 8589934591,
  8: 2097151
};
const encNumber = (buf, off, size, num) => num === void 0 ? false : num > MAXNUM[size] || num < 0 ? (encode$1(num, buf.subarray(off, off + size)), true) : (encSmallNumber(buf, off, size, num), false);
const encSmallNumber = (buf, off, size, num) => buf.write(octalString(num, size), off, size, "ascii");
const octalString = (num, size) => padOctal(Math.floor(num).toString(8), size);
const padOctal = (str, size) => (str.length === size - 1 ? str : new Array(size - str.length - 1).join("0") + str + " ") + "\0";
const encDate = (buf, off, size, date) => date === void 0 ? false : encNumber(buf, off, size, date.getTime() / 1e3);
const NULLS = new Array(156).join("\0");
const encString = (buf, off, size, str) => str === void 0 ? false : (buf.write(str + NULLS, off, size, "utf8"), str.length !== Buffer.byteLength(str) || str.length > size);
class Pax {
  atime;
  mtime;
  ctime;
  charset;
  comment;
  gid;
  uid;
  gname;
  uname;
  linkpath;
  dev;
  ino;
  nlink;
  path;
  size;
  mode;
  global;
  constructor(obj, global = false) {
    this.atime = obj.atime;
    this.charset = obj.charset;
    this.comment = obj.comment;
    this.ctime = obj.ctime;
    this.dev = obj.dev;
    this.gid = obj.gid;
    this.global = global;
    this.gname = obj.gname;
    this.ino = obj.ino;
    this.linkpath = obj.linkpath;
    this.mtime = obj.mtime;
    this.nlink = obj.nlink;
    this.path = obj.path;
    this.size = obj.size;
    this.uid = obj.uid;
    this.uname = obj.uname;
  }
  encode() {
    const body = this.encodeBody();
    if (body === "") {
      return Buffer.allocUnsafe(0);
    }
    const bodyLen = Buffer.byteLength(body);
    const bufLen = 512 * Math.ceil(1 + bodyLen / 512);
    const buf = Buffer.allocUnsafe(bufLen);
    for (let i = 0; i < 512; i++) {
      buf[i] = 0;
    }
    new Header({
      // XXX split the path
      // then the path should be PaxHeader + basename, but less than 99,
      // prepend with the dirname
      /* c8 ignore start */
      path: ("PaxHeader/" + basename(this.path ?? "")).slice(0, 99),
      /* c8 ignore stop */
      mode: this.mode || 420,
      uid: this.uid,
      gid: this.gid,
      size: bodyLen,
      mtime: this.mtime,
      type: this.global ? "GlobalExtendedHeader" : "ExtendedHeader",
      linkpath: "",
      uname: this.uname || "",
      gname: this.gname || "",
      devmaj: 0,
      devmin: 0,
      atime: this.atime,
      ctime: this.ctime
    }).encode(buf);
    buf.write(body, 512, bodyLen, "utf8");
    for (let i = bodyLen + 512; i < buf.length; i++) {
      buf[i] = 0;
    }
    return buf;
  }
  encodeBody() {
    return this.encodeField("path") + this.encodeField("ctime") + this.encodeField("atime") + this.encodeField("dev") + this.encodeField("ino") + this.encodeField("nlink") + this.encodeField("charset") + this.encodeField("comment") + this.encodeField("gid") + this.encodeField("gname") + this.encodeField("linkpath") + this.encodeField("mtime") + this.encodeField("size") + this.encodeField("uid") + this.encodeField("uname");
  }
  encodeField(field) {
    if (this[field] === void 0) {
      return "";
    }
    const r = this[field];
    const v = r instanceof Date ? r.getTime() / 1e3 : r;
    const s = " " + (field === "dev" || field === "ino" || field === "nlink" ? "SCHILY." : "") + field + "=" + v + "\n";
    const byteLen = Buffer.byteLength(s);
    let digits = Math.floor(Math.log(byteLen) / Math.log(10)) + 1;
    if (byteLen + digits >= Math.pow(10, digits)) {
      digits += 1;
    }
    const len = digits + byteLen;
    return len + s;
  }
  static parse(str, ex, g = false) {
    return new Pax(merge(parseKV(str), ex), g);
  }
}
const merge = (a, b) => b ? Object.assign({}, b, a) : a;
const parseKV = (str) => str.replace(/\n$/, "").split("\n").reduce(parseKVLine, /* @__PURE__ */ Object.create(null));
const parseKVLine = (set, line) => {
  const n = parseInt(line, 10);
  if (n !== Buffer.byteLength(line) + 1) {
    return set;
  }
  line = line.slice((n + " ").length);
  const kv = line.split("=");
  const r = kv.shift();
  if (!r) {
    return set;
  }
  const k = r.replace(/^SCHILY\.(dev|ino|nlink)/, "$1");
  const v = kv.join("=");
  set[k] = /^([A-Z]+\.)?([mac]|birth|creation)time$/.test(k) ? new Date(Number(v) * 1e3) : /^[0-9]+$/.test(v) ? +v : v;
  return set;
};
const platform$3 = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
const normalizeWindowsPath = platform$3 !== "win32" ? (p) => p : (p) => p && p.replace(/\\/g, "/");
class ReadEntry extends Minipass {
  extended;
  globalExtended;
  header;
  startBlockSize;
  blockRemain;
  remain;
  type;
  meta = false;
  ignore = false;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  size = 0;
  mtime;
  atime;
  ctime;
  linkpath;
  dev;
  ino;
  nlink;
  invalid = false;
  absolute;
  unsupported = false;
  constructor(header, ex, gex) {
    super({});
    this.pause();
    this.extended = ex;
    this.globalExtended = gex;
    this.header = header;
    this.remain = header.size ?? 0;
    this.startBlockSize = 512 * Math.ceil(this.remain / 512);
    this.blockRemain = this.startBlockSize;
    this.type = header.type;
    switch (this.type) {
      case "File":
      case "OldFile":
      case "Link":
      case "SymbolicLink":
      case "CharacterDevice":
      case "BlockDevice":
      case "Directory":
      case "FIFO":
      case "ContiguousFile":
      case "GNUDumpDir":
        break;
      case "NextFileHasLongLinkpath":
      case "NextFileHasLongPath":
      case "OldGnuLongPath":
      case "GlobalExtendedHeader":
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this.meta = true;
        break;
      // NOTE: gnutar and bsdtar treat unrecognized types as 'File'
      // it may be worth doing the same, but with a warning.
      default:
        this.ignore = true;
    }
    if (!header.path) {
      throw new Error("no path provided for tar.ReadEntry");
    }
    this.path = normalizeWindowsPath(header.path);
    this.mode = header.mode;
    if (this.mode) {
      this.mode = this.mode & 4095;
    }
    this.uid = header.uid;
    this.gid = header.gid;
    this.uname = header.uname;
    this.gname = header.gname;
    this.size = this.remain;
    this.mtime = header.mtime;
    this.atime = header.atime;
    this.ctime = header.ctime;
    this.linkpath = header.linkpath ? normalizeWindowsPath(header.linkpath) : void 0;
    this.uname = header.uname;
    this.gname = header.gname;
    if (ex) {
      this.#slurp(ex);
    }
    if (gex) {
      this.#slurp(gex, true);
    }
  }
  write(data) {
    const writeLen = data.length;
    if (writeLen > this.blockRemain) {
      throw new Error("writing more to entry than is appropriate");
    }
    const r = this.remain;
    const br = this.blockRemain;
    this.remain = Math.max(0, r - writeLen);
    this.blockRemain = Math.max(0, br - writeLen);
    if (this.ignore) {
      return true;
    }
    if (r >= writeLen) {
      return super.write(data);
    }
    return super.write(data.subarray(0, r));
  }
  #slurp(ex, gex = false) {
    if (ex.path)
      ex.path = normalizeWindowsPath(ex.path);
    if (ex.linkpath)
      ex.linkpath = normalizeWindowsPath(ex.linkpath);
    Object.assign(this, Object.fromEntries(Object.entries(ex).filter(([k, v]) => {
      return !(v === null || v === void 0 || k === "path" && gex);
    })));
  }
}
const warnMethod = (self, code2, message, data = {}) => {
  if (self.file) {
    data.file = self.file;
  }
  if (self.cwd) {
    data.cwd = self.cwd;
  }
  data.code = message instanceof Error && message.code || code2;
  data.tarCode = code2;
  if (!self.strict && data.recoverable !== false) {
    if (message instanceof Error) {
      data = Object.assign(message, data);
      message = message.message;
    }
    self.emit("warn", code2, message, data);
  } else if (message instanceof Error) {
    self.emit("error", Object.assign(message, data));
  } else {
    self.emit("error", Object.assign(new Error(`${code2}: ${message}`), data));
  }
};
const maxMetaEntrySize = 1024 * 1024;
const gzipHeader = Buffer.from([31, 139]);
const zstdHeader = Buffer.from([40, 181, 47, 253]);
const ZIP_HEADER_LEN = Math.max(gzipHeader.length, zstdHeader.length);
const STATE = Symbol("state");
const WRITEENTRY = Symbol("writeEntry");
const READENTRY = Symbol("readEntry");
const NEXTENTRY = Symbol("nextEntry");
const PROCESSENTRY = Symbol("processEntry");
const EX = Symbol("extendedHeader");
const GEX = Symbol("globalExtendedHeader");
const META = Symbol("meta");
const EMITMETA = Symbol("emitMeta");
const BUFFER = Symbol("buffer");
const QUEUE$1 = Symbol("queue");
const ENDED$2 = Symbol("ended");
const EMITTEDEND = Symbol("emittedEnd");
const EMIT = Symbol("emit");
const UNZIP = Symbol("unzip");
const CONSUMECHUNK = Symbol("consumeChunk");
const CONSUMECHUNKSUB = Symbol("consumeChunkSub");
const CONSUMEBODY = Symbol("consumeBody");
const CONSUMEMETA = Symbol("consumeMeta");
const CONSUMEHEADER = Symbol("consumeHeader");
const CONSUMING = Symbol("consuming");
const BUFFERCONCAT = Symbol("bufferConcat");
const MAYBEEND = Symbol("maybeEnd");
const WRITING = Symbol("writing");
const ABORTED = Symbol("aborted");
const DONE = Symbol("onDone");
const SAW_VALID_ENTRY = Symbol("sawValidEntry");
const SAW_NULL_BLOCK = Symbol("sawNullBlock");
const SAW_EOF = Symbol("sawEOF");
const CLOSESTREAM = Symbol("closeStream");
const noop = () => true;
class Parser extends EventEmitter$1 {
  file;
  strict;
  maxMetaEntrySize;
  filter;
  brotli;
  zstd;
  writable = true;
  readable = false;
  [QUEUE$1] = [];
  [BUFFER];
  [READENTRY];
  [WRITEENTRY];
  [STATE] = "begin";
  [META] = "";
  [EX];
  [GEX];
  [ENDED$2] = false;
  [UNZIP];
  [ABORTED] = false;
  [SAW_VALID_ENTRY];
  [SAW_NULL_BLOCK] = false;
  [SAW_EOF] = false;
  [WRITING] = false;
  [CONSUMING] = false;
  [EMITTEDEND] = false;
  constructor(opt = {}) {
    super();
    this.file = opt.file || "";
    this.on(DONE, () => {
      if (this[STATE] === "begin" || this[SAW_VALID_ENTRY] === false) {
        this.warn("TAR_BAD_ARCHIVE", "Unrecognized archive format");
      }
    });
    if (opt.ondone) {
      this.on(DONE, opt.ondone);
    } else {
      this.on(DONE, () => {
        this.emit("prefinish");
        this.emit("finish");
        this.emit("end");
      });
    }
    this.strict = !!opt.strict;
    this.maxMetaEntrySize = opt.maxMetaEntrySize || maxMetaEntrySize;
    this.filter = typeof opt.filter === "function" ? opt.filter : noop;
    const isTBR = opt.file && (opt.file.endsWith(".tar.br") || opt.file.endsWith(".tbr"));
    this.brotli = !(opt.gzip || opt.zstd) && opt.brotli !== void 0 ? opt.brotli : isTBR ? void 0 : false;
    const isTZST = opt.file && (opt.file.endsWith(".tar.zst") || opt.file.endsWith(".tzst"));
    this.zstd = !(opt.gzip || opt.brotli) && opt.zstd !== void 0 ? opt.zstd : isTZST ? true : void 0;
    this.on("end", () => this[CLOSESTREAM]());
    if (typeof opt.onwarn === "function") {
      this.on("warn", opt.onwarn);
    }
    if (typeof opt.onReadEntry === "function") {
      this.on("entry", opt.onReadEntry);
    }
  }
  warn(code2, message, data = {}) {
    warnMethod(this, code2, message, data);
  }
  [CONSUMEHEADER](chunk, position) {
    if (this[SAW_VALID_ENTRY] === void 0) {
      this[SAW_VALID_ENTRY] = false;
    }
    let header;
    try {
      header = new Header(chunk, position, this[EX], this[GEX]);
    } catch (er) {
      return this.warn("TAR_ENTRY_INVALID", er);
    }
    if (header.nullBlock) {
      if (this[SAW_NULL_BLOCK]) {
        this[SAW_EOF] = true;
        if (this[STATE] === "begin") {
          this[STATE] = "header";
        }
        this[EMIT]("eof");
      } else {
        this[SAW_NULL_BLOCK] = true;
        this[EMIT]("nullBlock");
      }
    } else {
      this[SAW_NULL_BLOCK] = false;
      if (!header.cksumValid) {
        this.warn("TAR_ENTRY_INVALID", "checksum failure", { header });
      } else if (!header.path) {
        this.warn("TAR_ENTRY_INVALID", "path is required", { header });
      } else {
        const type = header.type;
        if (/^(Symbolic)?Link$/.test(type) && !header.linkpath) {
          this.warn("TAR_ENTRY_INVALID", "linkpath required", {
            header
          });
        } else if (!/^(Symbolic)?Link$/.test(type) && !/^(Global)?ExtendedHeader$/.test(type) && header.linkpath) {
          this.warn("TAR_ENTRY_INVALID", "linkpath forbidden", {
            header
          });
        } else {
          const entry = this[WRITEENTRY] = new ReadEntry(header, this[EX], this[GEX]);
          if (!this[SAW_VALID_ENTRY]) {
            if (entry.remain) {
              const onend = () => {
                if (!entry.invalid) {
                  this[SAW_VALID_ENTRY] = true;
                }
              };
              entry.on("end", onend);
            } else {
              this[SAW_VALID_ENTRY] = true;
            }
          }
          if (entry.meta) {
            if (entry.size > this.maxMetaEntrySize) {
              entry.ignore = true;
              this[EMIT]("ignoredEntry", entry);
              this[STATE] = "ignore";
              entry.resume();
            } else if (entry.size > 0) {
              this[META] = "";
              entry.on("data", (c) => this[META] += c);
              this[STATE] = "meta";
            }
          } else {
            this[EX] = void 0;
            entry.ignore = entry.ignore || !this.filter(entry.path, entry);
            if (entry.ignore) {
              this[EMIT]("ignoredEntry", entry);
              this[STATE] = entry.remain ? "ignore" : "header";
              entry.resume();
            } else {
              if (entry.remain) {
                this[STATE] = "body";
              } else {
                this[STATE] = "header";
                entry.end();
              }
              if (!this[READENTRY]) {
                this[QUEUE$1].push(entry);
                this[NEXTENTRY]();
              } else {
                this[QUEUE$1].push(entry);
              }
            }
          }
        }
      }
    }
  }
  [CLOSESTREAM]() {
    queueMicrotask(() => this.emit("close"));
  }
  [PROCESSENTRY](entry) {
    let go = true;
    if (!entry) {
      this[READENTRY] = void 0;
      go = false;
    } else if (Array.isArray(entry)) {
      const [ev, ...args] = entry;
      this.emit(ev, ...args);
    } else {
      this[READENTRY] = entry;
      this.emit("entry", entry);
      if (!entry.emittedEnd) {
        entry.on("end", () => this[NEXTENTRY]());
        go = false;
      }
    }
    return go;
  }
  [NEXTENTRY]() {
    do {
    } while (this[PROCESSENTRY](this[QUEUE$1].shift()));
    if (!this[QUEUE$1].length) {
      const re = this[READENTRY];
      const drainNow = !re || re.flowing || re.size === re.remain;
      if (drainNow) {
        if (!this[WRITING]) {
          this.emit("drain");
        }
      } else {
        re.once("drain", () => this.emit("drain"));
      }
    }
  }
  [CONSUMEBODY](chunk, position) {
    const entry = this[WRITEENTRY];
    if (!entry) {
      throw new Error("attempt to consume body without entry??");
    }
    const br = entry.blockRemain ?? 0;
    const c = br >= chunk.length && position === 0 ? chunk : chunk.subarray(position, position + br);
    entry.write(c);
    if (!entry.blockRemain) {
      this[STATE] = "header";
      this[WRITEENTRY] = void 0;
      entry.end();
    }
    return c.length;
  }
  [CONSUMEMETA](chunk, position) {
    const entry = this[WRITEENTRY];
    const ret = this[CONSUMEBODY](chunk, position);
    if (!this[WRITEENTRY] && entry) {
      this[EMITMETA](entry);
    }
    return ret;
  }
  [EMIT](ev, data, extra) {
    if (!this[QUEUE$1].length && !this[READENTRY]) {
      this.emit(ev, data, extra);
    } else {
      this[QUEUE$1].push([ev, data, extra]);
    }
  }
  [EMITMETA](entry) {
    this[EMIT]("meta", this[META]);
    switch (entry.type) {
      case "ExtendedHeader":
      case "OldExtendedHeader":
        this[EX] = Pax.parse(this[META], this[EX], false);
        break;
      case "GlobalExtendedHeader":
        this[GEX] = Pax.parse(this[META], this[GEX], true);
        break;
      case "NextFileHasLongPath":
      case "OldGnuLongPath": {
        const ex = this[EX] ?? /* @__PURE__ */ Object.create(null);
        this[EX] = ex;
        ex.path = this[META].replace(/\0.*/, "");
        break;
      }
      case "NextFileHasLongLinkpath": {
        const ex = this[EX] || /* @__PURE__ */ Object.create(null);
        this[EX] = ex;
        ex.linkpath = this[META].replace(/\0.*/, "");
        break;
      }
      /* c8 ignore start */
      default:
        throw new Error("unknown meta: " + entry.type);
    }
  }
  abort(error) {
    this[ABORTED] = true;
    this.emit("abort", error);
    this.warn("TAR_ABORT", error, { recoverable: false });
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (typeof chunk === "string") {
      chunk = Buffer.from(
        chunk,
        /* c8 ignore next */
        typeof encoding === "string" ? encoding : "utf8"
      );
    }
    if (this[ABORTED]) {
      cb?.();
      return false;
    }
    const needSniff = this[UNZIP] === void 0 || this.brotli === void 0 && this[UNZIP] === false;
    if (needSniff && chunk) {
      if (this[BUFFER]) {
        chunk = Buffer.concat([this[BUFFER], chunk]);
        this[BUFFER] = void 0;
      }
      if (chunk.length < ZIP_HEADER_LEN) {
        this[BUFFER] = chunk;
        cb?.();
        return true;
      }
      for (let i = 0; this[UNZIP] === void 0 && i < gzipHeader.length; i++) {
        if (chunk[i] !== gzipHeader[i]) {
          this[UNZIP] = false;
        }
      }
      let isZstd = false;
      if (this[UNZIP] === false && this.zstd !== false) {
        isZstd = true;
        for (let i = 0; i < zstdHeader.length; i++) {
          if (chunk[i] !== zstdHeader[i]) {
            isZstd = false;
            break;
          }
        }
      }
      const maybeBrotli = this.brotli === void 0 && !isZstd;
      if (this[UNZIP] === false && maybeBrotli) {
        if (chunk.length < 512) {
          if (this[ENDED$2]) {
            this.brotli = true;
          } else {
            this[BUFFER] = chunk;
            cb?.();
            return true;
          }
        } else {
          try {
            new Header(chunk.subarray(0, 512));
            this.brotli = false;
          } catch (_) {
            this.brotli = true;
          }
        }
      }
      if (this[UNZIP] === void 0 || this[UNZIP] === false && (this.brotli || isZstd)) {
        const ended = this[ENDED$2];
        this[ENDED$2] = false;
        this[UNZIP] = this[UNZIP] === void 0 ? new Unzip({}) : isZstd ? new ZstdDecompress({}) : new BrotliDecompress({});
        this[UNZIP].on("data", (chunk2) => this[CONSUMECHUNK](chunk2));
        this[UNZIP].on("error", (er) => this.abort(er));
        this[UNZIP].on("end", () => {
          this[ENDED$2] = true;
          this[CONSUMECHUNK]();
        });
        this[WRITING] = true;
        const ret2 = !!this[UNZIP][ended ? "end" : "write"](chunk);
        this[WRITING] = false;
        cb?.();
        return ret2;
      }
    }
    this[WRITING] = true;
    if (this[UNZIP]) {
      this[UNZIP].write(chunk);
    } else {
      this[CONSUMECHUNK](chunk);
    }
    this[WRITING] = false;
    const ret = this[QUEUE$1].length ? false : this[READENTRY] ? this[READENTRY].flowing : true;
    if (!ret && !this[QUEUE$1].length) {
      this[READENTRY]?.once("drain", () => this.emit("drain"));
    }
    cb?.();
    return ret;
  }
  [BUFFERCONCAT](c) {
    if (c && !this[ABORTED]) {
      this[BUFFER] = this[BUFFER] ? Buffer.concat([this[BUFFER], c]) : c;
    }
  }
  [MAYBEEND]() {
    if (this[ENDED$2] && !this[EMITTEDEND] && !this[ABORTED] && !this[CONSUMING]) {
      this[EMITTEDEND] = true;
      const entry = this[WRITEENTRY];
      if (entry && entry.blockRemain) {
        const have = this[BUFFER] ? this[BUFFER].length : 0;
        this.warn("TAR_BAD_ARCHIVE", `Truncated input (needed ${entry.blockRemain} more bytes, only ${have} available)`, { entry });
        if (this[BUFFER]) {
          entry.write(this[BUFFER]);
        }
        entry.end();
      }
      this[EMIT](DONE);
    }
  }
  [CONSUMECHUNK](chunk) {
    if (this[CONSUMING] && chunk) {
      this[BUFFERCONCAT](chunk);
    } else if (!chunk && !this[BUFFER]) {
      this[MAYBEEND]();
    } else if (chunk) {
      this[CONSUMING] = true;
      if (this[BUFFER]) {
        this[BUFFERCONCAT](chunk);
        const c = this[BUFFER];
        this[BUFFER] = void 0;
        this[CONSUMECHUNKSUB](c);
      } else {
        this[CONSUMECHUNKSUB](chunk);
      }
      while (this[BUFFER] && this[BUFFER]?.length >= 512 && !this[ABORTED] && !this[SAW_EOF]) {
        const c = this[BUFFER];
        this[BUFFER] = void 0;
        this[CONSUMECHUNKSUB](c);
      }
      this[CONSUMING] = false;
    }
    if (!this[BUFFER] || this[ENDED$2]) {
      this[MAYBEEND]();
    }
  }
  [CONSUMECHUNKSUB](chunk) {
    let position = 0;
    const length = chunk.length;
    while (position + 512 <= length && !this[ABORTED] && !this[SAW_EOF]) {
      switch (this[STATE]) {
        case "begin":
        case "header":
          this[CONSUMEHEADER](chunk, position);
          position += 512;
          break;
        case "ignore":
        case "body":
          position += this[CONSUMEBODY](chunk, position);
          break;
        case "meta":
          position += this[CONSUMEMETA](chunk, position);
          break;
        /* c8 ignore start */
        default:
          throw new Error("invalid state: " + this[STATE]);
      }
    }
    if (position < length) {
      if (this[BUFFER]) {
        this[BUFFER] = Buffer.concat([
          chunk.subarray(position),
          this[BUFFER]
        ]);
      } else {
        this[BUFFER] = chunk.subarray(position);
      }
    }
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      encoding = void 0;
      chunk = void 0;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (typeof chunk === "string") {
      chunk = Buffer.from(chunk, encoding);
    }
    if (cb)
      this.once("finish", cb);
    if (!this[ABORTED]) {
      if (this[UNZIP]) {
        if (chunk)
          this[UNZIP].write(chunk);
        this[UNZIP].end();
      } else {
        this[ENDED$2] = true;
        if (this.brotli === void 0 || this.zstd === void 0)
          chunk = chunk || Buffer.alloc(0);
        if (chunk)
          this.write(chunk);
        this[MAYBEEND]();
      }
    }
    return this;
  }
}
const stripTrailingSlashes = (str) => {
  let i = str.length - 1;
  let slashesStart = -1;
  while (i > -1 && str.charAt(i) === "/") {
    slashesStart = i;
    i--;
  }
  return slashesStart === -1 ? str : str.slice(0, slashesStart);
};
const onReadEntryFunction = (opt) => {
  const onReadEntry = opt.onReadEntry;
  opt.onReadEntry = onReadEntry ? (e) => {
    onReadEntry(e);
    e.resume();
  } : (e) => e.resume();
};
const filesFilter = (opt, files) => {
  const map = new Map(files.map((f) => [stripTrailingSlashes(f), true]));
  const filter = opt.filter;
  const mapHas = (file, r = "") => {
    const root = r || parse$2(file).root || ".";
    let ret;
    if (file === root)
      ret = false;
    else {
      const m = map.get(file);
      if (m !== void 0) {
        ret = m;
      } else {
        ret = mapHas(dirname(file), root);
      }
    }
    map.set(file, ret);
    return ret;
  };
  opt.filter = filter ? (file, entry) => filter(file, entry) && mapHas(stripTrailingSlashes(file)) : (file) => mapHas(stripTrailingSlashes(file));
};
const listFileSync = (opt) => {
  const p = new Parser(opt);
  const file = opt.file;
  let fd;
  try {
    fd = fs__default.openSync(file, "r");
    const stat = fs__default.fstatSync(fd);
    const readSize = opt.maxReadSize || 16 * 1024 * 1024;
    if (stat.size < readSize) {
      const buf = Buffer.allocUnsafe(stat.size);
      fs__default.readSync(fd, buf, 0, stat.size, 0);
      p.end(buf);
    } else {
      let pos2 = 0;
      const buf = Buffer.allocUnsafe(readSize);
      while (pos2 < stat.size) {
        const bytesRead = fs__default.readSync(fd, buf, 0, readSize, pos2);
        pos2 += bytesRead;
        p.write(buf.subarray(0, bytesRead));
      }
      p.end();
    }
  } finally {
    if (typeof fd === "number") {
      try {
        fs__default.closeSync(fd);
      } catch (er) {
      }
    }
  }
};
const listFile = (opt, _files) => {
  const parse2 = new Parser(opt);
  const readSize = opt.maxReadSize || 16 * 1024 * 1024;
  const file = opt.file;
  const p = new Promise((resolve2, reject) => {
    parse2.on("error", reject);
    parse2.on("end", resolve2);
    fs__default.stat(file, (er, stat) => {
      if (er) {
        reject(er);
      } else {
        const stream = new ReadStream(file, {
          readSize,
          size: stat.size
        });
        stream.on("error", reject);
        stream.pipe(parse2);
      }
    });
  });
  return p;
};
const list = makeCommand(listFileSync, listFile, (opt) => new Parser(opt), (opt) => new Parser(opt), (opt, files) => {
  if (files?.length)
    filesFilter(opt, files);
  if (!opt.noResume)
    onReadEntryFunction(opt);
});
const modeFix = (mode, isDir, portable) => {
  mode &= 4095;
  if (portable) {
    mode = (mode | 384) & -19;
  }
  if (isDir) {
    if (mode & 256) {
      mode |= 64;
    }
    if (mode & 32) {
      mode |= 8;
    }
    if (mode & 4) {
      mode |= 1;
    }
  }
  return mode;
};
const { isAbsolute, parse } = win32;
const stripAbsolutePath = (path) => {
  let r = "";
  let parsed = parse(path);
  while (isAbsolute(path) || parsed.root) {
    const root = path.charAt(0) === "/" && path.slice(0, 4) !== "//?/" ? "/" : parsed.root;
    path = path.slice(root.length);
    r += root;
    parsed = parse(path);
  }
  return [r, path];
};
const raw = ["|", "<", ">", "?", ":"];
const win = raw.map((char) => String.fromCharCode(61440 + char.charCodeAt(0)));
const toWin = new Map(raw.map((char, i) => [char, win[i]]));
const toRaw = new Map(win.map((char, i) => [char, raw[i]]));
const encode = (s) => raw.reduce((s2, c) => s2.split(c).join(toWin.get(c)), s);
const decode = (s) => win.reduce((s2, c) => s2.split(c).join(toRaw.get(c)), s);
const prefixPath = (path, prefix) => {
  if (!prefix) {
    return normalizeWindowsPath(path);
  }
  path = normalizeWindowsPath(path).replace(/^\.(\/|$)/, "");
  return stripTrailingSlashes(prefix) + "/" + path;
};
const maxReadSize = 16 * 1024 * 1024;
const PROCESS$1 = Symbol("process");
const FILE$1 = Symbol("file");
const DIRECTORY$1 = Symbol("directory");
const SYMLINK$1 = Symbol("symlink");
const HARDLINK$1 = Symbol("hardlink");
const HEADER = Symbol("header");
const READ = Symbol("read");
const LSTAT = Symbol("lstat");
const ONLSTAT = Symbol("onlstat");
const ONREAD = Symbol("onread");
const ONREADLINK = Symbol("onreadlink");
const OPENFILE = Symbol("openfile");
const ONOPENFILE = Symbol("onopenfile");
const CLOSE = Symbol("close");
const MODE = Symbol("mode");
const AWAITDRAIN = Symbol("awaitDrain");
const ONDRAIN$1 = Symbol("ondrain");
const PREFIX = Symbol("prefix");
class WriteEntry extends Minipass {
  path;
  portable;
  myuid = process.getuid && process.getuid() || 0;
  // until node has builtin pwnam functions, this'll have to do
  myuser = process.env.USER || "";
  maxReadSize;
  linkCache;
  statCache;
  preservePaths;
  cwd;
  strict;
  mtime;
  noPax;
  noMtime;
  prefix;
  fd;
  blockLen = 0;
  blockRemain = 0;
  buf;
  pos = 0;
  remain = 0;
  length = 0;
  offset = 0;
  win32;
  absolute;
  header;
  type;
  linkpath;
  stat;
  onWriteEntry;
  #hadError = false;
  constructor(p, opt_ = {}) {
    const opt = dealias(opt_);
    super();
    this.path = normalizeWindowsPath(p);
    this.portable = !!opt.portable;
    this.maxReadSize = opt.maxReadSize || maxReadSize;
    this.linkCache = opt.linkCache || /* @__PURE__ */ new Map();
    this.statCache = opt.statCache || /* @__PURE__ */ new Map();
    this.preservePaths = !!opt.preservePaths;
    this.cwd = normalizeWindowsPath(opt.cwd || process.cwd());
    this.strict = !!opt.strict;
    this.noPax = !!opt.noPax;
    this.noMtime = !!opt.noMtime;
    this.mtime = opt.mtime;
    this.prefix = opt.prefix ? normalizeWindowsPath(opt.prefix) : void 0;
    this.onWriteEntry = opt.onWriteEntry;
    if (typeof opt.onwarn === "function") {
      this.on("warn", opt.onwarn);
    }
    let pathWarn = false;
    if (!this.preservePaths) {
      const [root, stripped] = stripAbsolutePath(this.path);
      if (root && typeof stripped === "string") {
        this.path = stripped;
        pathWarn = root;
      }
    }
    this.win32 = !!opt.win32 || process.platform === "win32";
    if (this.win32) {
      this.path = decode(this.path.replace(/\\/g, "/"));
      p = p.replace(/\\/g, "/");
    }
    this.absolute = normalizeWindowsPath(opt.absolute || require$$0.resolve(this.cwd, p));
    if (this.path === "") {
      this.path = "./";
    }
    if (pathWarn) {
      this.warn("TAR_ENTRY_INFO", `stripping ${pathWarn} from absolute path`, {
        entry: this,
        path: pathWarn + this.path
      });
    }
    const cs = this.statCache.get(this.absolute);
    if (cs) {
      this[ONLSTAT](cs);
    } else {
      this[LSTAT]();
    }
  }
  warn(code2, message, data = {}) {
    return warnMethod(this, code2, message, data);
  }
  emit(ev, ...data) {
    if (ev === "error") {
      this.#hadError = true;
    }
    return super.emit(ev, ...data);
  }
  [LSTAT]() {
    fs.lstat(this.absolute, (er, stat) => {
      if (er) {
        return this.emit("error", er);
      }
      this[ONLSTAT](stat);
    });
  }
  [ONLSTAT](stat) {
    this.statCache.set(this.absolute, stat);
    this.stat = stat;
    if (!stat.isFile()) {
      stat.size = 0;
    }
    this.type = getType(stat);
    this.emit("stat", stat);
    this[PROCESS$1]();
  }
  [PROCESS$1]() {
    switch (this.type) {
      case "File":
        return this[FILE$1]();
      case "Directory":
        return this[DIRECTORY$1]();
      case "SymbolicLink":
        return this[SYMLINK$1]();
      // unsupported types are ignored.
      default:
        return this.end();
    }
  }
  [MODE](mode) {
    return modeFix(mode, this.type === "Directory", this.portable);
  }
  [PREFIX](path) {
    return prefixPath(path, this.prefix);
  }
  [HEADER]() {
    if (!this.stat) {
      throw new Error("cannot write header before stat");
    }
    if (this.type === "Directory" && this.portable) {
      this.noMtime = true;
    }
    this.onWriteEntry?.(this);
    this.header = new Header({
      path: this[PREFIX](this.path),
      // only apply the prefix to hard links.
      linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[PREFIX](this.linkpath) : this.linkpath,
      // only the permissions and setuid/setgid/sticky bitflags
      // not the higher-order bits that specify file type
      mode: this[MODE](this.stat.mode),
      uid: this.portable ? void 0 : this.stat.uid,
      gid: this.portable ? void 0 : this.stat.gid,
      size: this.stat.size,
      mtime: this.noMtime ? void 0 : this.mtime || this.stat.mtime,
      /* c8 ignore next */
      type: this.type === "Unsupported" ? void 0 : this.type,
      uname: this.portable ? void 0 : this.stat.uid === this.myuid ? this.myuser : "",
      atime: this.portable ? void 0 : this.stat.atime,
      ctime: this.portable ? void 0 : this.stat.ctime
    });
    if (this.header.encode() && !this.noPax) {
      super.write(new Pax({
        atime: this.portable ? void 0 : this.header.atime,
        ctime: this.portable ? void 0 : this.header.ctime,
        gid: this.portable ? void 0 : this.header.gid,
        mtime: this.noMtime ? void 0 : this.mtime || this.header.mtime,
        path: this[PREFIX](this.path),
        linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[PREFIX](this.linkpath) : this.linkpath,
        size: this.header.size,
        uid: this.portable ? void 0 : this.header.uid,
        uname: this.portable ? void 0 : this.header.uname,
        dev: this.portable ? void 0 : this.stat.dev,
        ino: this.portable ? void 0 : this.stat.ino,
        nlink: this.portable ? void 0 : this.stat.nlink
      }).encode());
    }
    const block = this.header?.block;
    if (!block) {
      throw new Error("failed to encode header");
    }
    super.write(block);
  }
  [DIRECTORY$1]() {
    if (!this.stat) {
      throw new Error("cannot create directory entry without stat");
    }
    if (this.path.slice(-1) !== "/") {
      this.path += "/";
    }
    this.stat.size = 0;
    this[HEADER]();
    this.end();
  }
  [SYMLINK$1]() {
    fs.readlink(this.absolute, (er, linkpath) => {
      if (er) {
        return this.emit("error", er);
      }
      this[ONREADLINK](linkpath);
    });
  }
  [ONREADLINK](linkpath) {
    this.linkpath = normalizeWindowsPath(linkpath);
    this[HEADER]();
    this.end();
  }
  [HARDLINK$1](linkpath) {
    if (!this.stat) {
      throw new Error("cannot create link entry without stat");
    }
    this.type = "Link";
    this.linkpath = normalizeWindowsPath(require$$0.relative(this.cwd, linkpath));
    this.stat.size = 0;
    this[HEADER]();
    this.end();
  }
  [FILE$1]() {
    if (!this.stat) {
      throw new Error("cannot create file entry without stat");
    }
    if (this.stat.nlink > 1) {
      const linkKey = `${this.stat.dev}:${this.stat.ino}`;
      const linkpath = this.linkCache.get(linkKey);
      if (linkpath?.indexOf(this.cwd) === 0) {
        return this[HARDLINK$1](linkpath);
      }
      this.linkCache.set(linkKey, this.absolute);
    }
    this[HEADER]();
    if (this.stat.size === 0) {
      return this.end();
    }
    this[OPENFILE]();
  }
  [OPENFILE]() {
    fs.open(this.absolute, "r", (er, fd) => {
      if (er) {
        return this.emit("error", er);
      }
      this[ONOPENFILE](fd);
    });
  }
  [ONOPENFILE](fd) {
    this.fd = fd;
    if (this.#hadError) {
      return this[CLOSE]();
    }
    if (!this.stat) {
      throw new Error("should stat before calling onopenfile");
    }
    this.blockLen = 512 * Math.ceil(this.stat.size / 512);
    this.blockRemain = this.blockLen;
    const bufLen = Math.min(this.blockLen, this.maxReadSize);
    this.buf = Buffer.allocUnsafe(bufLen);
    this.offset = 0;
    this.pos = 0;
    this.remain = this.stat.size;
    this.length = this.buf.length;
    this[READ]();
  }
  [READ]() {
    const { fd, buf, offset, length, pos: pos2 } = this;
    if (fd === void 0 || buf === void 0) {
      throw new Error("cannot read file without first opening");
    }
    fs.read(fd, buf, offset, length, pos2, (er, bytesRead) => {
      if (er) {
        return this[CLOSE](() => this.emit("error", er));
      }
      this[ONREAD](bytesRead);
    });
  }
  /* c8 ignore start */
  [CLOSE](cb = () => {
  }) {
    if (this.fd !== void 0)
      fs.close(this.fd, cb);
  }
  [ONREAD](bytesRead) {
    if (bytesRead <= 0 && this.remain > 0) {
      const er = Object.assign(new Error("encountered unexpected EOF"), {
        path: this.absolute,
        syscall: "read",
        code: "EOF"
      });
      return this[CLOSE](() => this.emit("error", er));
    }
    if (bytesRead > this.remain) {
      const er = Object.assign(new Error("did not encounter expected EOF"), {
        path: this.absolute,
        syscall: "read",
        code: "EOF"
      });
      return this[CLOSE](() => this.emit("error", er));
    }
    if (!this.buf) {
      throw new Error("should have created buffer prior to reading");
    }
    if (bytesRead === this.remain) {
      for (let i = bytesRead; i < this.length && bytesRead < this.blockRemain; i++) {
        this.buf[i + this.offset] = 0;
        bytesRead++;
        this.remain++;
      }
    }
    const chunk = this.offset === 0 && bytesRead === this.buf.length ? this.buf : this.buf.subarray(this.offset, this.offset + bytesRead);
    const flushed = this.write(chunk);
    if (!flushed) {
      this[AWAITDRAIN](() => this[ONDRAIN$1]());
    } else {
      this[ONDRAIN$1]();
    }
  }
  [AWAITDRAIN](cb) {
    this.once("drain", cb);
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (typeof chunk === "string") {
      chunk = Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
    }
    if (this.blockRemain < chunk.length) {
      const er = Object.assign(new Error("writing more data than expected"), {
        path: this.absolute
      });
      return this.emit("error", er);
    }
    this.remain -= chunk.length;
    this.blockRemain -= chunk.length;
    this.pos += chunk.length;
    this.offset += chunk.length;
    return super.write(chunk, null, cb);
  }
  [ONDRAIN$1]() {
    if (!this.remain) {
      if (this.blockRemain) {
        super.write(Buffer.alloc(this.blockRemain));
      }
      return this[CLOSE]((er) => er ? this.emit("error", er) : this.end());
    }
    if (!this.buf) {
      throw new Error("buffer lost somehow in ONDRAIN");
    }
    if (this.offset >= this.length) {
      this.buf = Buffer.allocUnsafe(Math.min(this.blockRemain, this.buf.length));
      this.offset = 0;
    }
    this.length = this.buf.length - this.offset;
    this[READ]();
  }
}
class WriteEntrySync extends WriteEntry {
  sync = true;
  [LSTAT]() {
    this[ONLSTAT](fs.lstatSync(this.absolute));
  }
  [SYMLINK$1]() {
    this[ONREADLINK](fs.readlinkSync(this.absolute));
  }
  [OPENFILE]() {
    this[ONOPENFILE](fs.openSync(this.absolute, "r"));
  }
  [READ]() {
    let threw = true;
    try {
      const { fd, buf, offset, length, pos: pos2 } = this;
      if (fd === void 0 || buf === void 0) {
        throw new Error("fd and buf must be set in READ method");
      }
      const bytesRead = fs.readSync(fd, buf, offset, length, pos2);
      this[ONREAD](bytesRead);
      threw = false;
    } finally {
      if (threw) {
        try {
          this[CLOSE](() => {
          });
        } catch (er) {
        }
      }
    }
  }
  [AWAITDRAIN](cb) {
    cb();
  }
  /* c8 ignore start */
  [CLOSE](cb = () => {
  }) {
    if (this.fd !== void 0)
      fs.closeSync(this.fd);
    cb();
  }
}
class WriteEntryTar extends Minipass {
  blockLen = 0;
  blockRemain = 0;
  buf = 0;
  pos = 0;
  remain = 0;
  length = 0;
  preservePaths;
  portable;
  strict;
  noPax;
  noMtime;
  readEntry;
  type;
  prefix;
  path;
  mode;
  uid;
  gid;
  uname;
  gname;
  header;
  mtime;
  atime;
  ctime;
  linkpath;
  size;
  onWriteEntry;
  warn(code2, message, data = {}) {
    return warnMethod(this, code2, message, data);
  }
  constructor(readEntry, opt_ = {}) {
    const opt = dealias(opt_);
    super();
    this.preservePaths = !!opt.preservePaths;
    this.portable = !!opt.portable;
    this.strict = !!opt.strict;
    this.noPax = !!opt.noPax;
    this.noMtime = !!opt.noMtime;
    this.onWriteEntry = opt.onWriteEntry;
    this.readEntry = readEntry;
    const { type } = readEntry;
    if (type === "Unsupported") {
      throw new Error("writing entry that should be ignored");
    }
    this.type = type;
    if (this.type === "Directory" && this.portable) {
      this.noMtime = true;
    }
    this.prefix = opt.prefix;
    this.path = normalizeWindowsPath(readEntry.path);
    this.mode = readEntry.mode !== void 0 ? this[MODE](readEntry.mode) : void 0;
    this.uid = this.portable ? void 0 : readEntry.uid;
    this.gid = this.portable ? void 0 : readEntry.gid;
    this.uname = this.portable ? void 0 : readEntry.uname;
    this.gname = this.portable ? void 0 : readEntry.gname;
    this.size = readEntry.size;
    this.mtime = this.noMtime ? void 0 : opt.mtime || readEntry.mtime;
    this.atime = this.portable ? void 0 : readEntry.atime;
    this.ctime = this.portable ? void 0 : readEntry.ctime;
    this.linkpath = readEntry.linkpath !== void 0 ? normalizeWindowsPath(readEntry.linkpath) : void 0;
    if (typeof opt.onwarn === "function") {
      this.on("warn", opt.onwarn);
    }
    let pathWarn = false;
    if (!this.preservePaths) {
      const [root, stripped] = stripAbsolutePath(this.path);
      if (root && typeof stripped === "string") {
        this.path = stripped;
        pathWarn = root;
      }
    }
    this.remain = readEntry.size;
    this.blockRemain = readEntry.startBlockSize;
    this.onWriteEntry?.(this);
    this.header = new Header({
      path: this[PREFIX](this.path),
      linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[PREFIX](this.linkpath) : this.linkpath,
      // only the permissions and setuid/setgid/sticky bitflags
      // not the higher-order bits that specify file type
      mode: this.mode,
      uid: this.portable ? void 0 : this.uid,
      gid: this.portable ? void 0 : this.gid,
      size: this.size,
      mtime: this.noMtime ? void 0 : this.mtime,
      type: this.type,
      uname: this.portable ? void 0 : this.uname,
      atime: this.portable ? void 0 : this.atime,
      ctime: this.portable ? void 0 : this.ctime
    });
    if (pathWarn) {
      this.warn("TAR_ENTRY_INFO", `stripping ${pathWarn} from absolute path`, {
        entry: this,
        path: pathWarn + this.path
      });
    }
    if (this.header.encode() && !this.noPax) {
      super.write(new Pax({
        atime: this.portable ? void 0 : this.atime,
        ctime: this.portable ? void 0 : this.ctime,
        gid: this.portable ? void 0 : this.gid,
        mtime: this.noMtime ? void 0 : this.mtime,
        path: this[PREFIX](this.path),
        linkpath: this.type === "Link" && this.linkpath !== void 0 ? this[PREFIX](this.linkpath) : this.linkpath,
        size: this.size,
        uid: this.portable ? void 0 : this.uid,
        uname: this.portable ? void 0 : this.uname,
        dev: this.portable ? void 0 : this.readEntry.dev,
        ino: this.portable ? void 0 : this.readEntry.ino,
        nlink: this.portable ? void 0 : this.readEntry.nlink
      }).encode());
    }
    const b = this.header?.block;
    if (!b)
      throw new Error("failed to encode header");
    super.write(b);
    readEntry.pipe(this);
  }
  [PREFIX](path) {
    return prefixPath(path, this.prefix);
  }
  [MODE](mode) {
    return modeFix(mode, this.type === "Directory", this.portable);
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (typeof chunk === "string") {
      chunk = Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
    }
    const writeLen = chunk.length;
    if (writeLen > this.blockRemain) {
      throw new Error("writing more to entry than is appropriate");
    }
    this.blockRemain -= writeLen;
    return super.write(chunk, cb);
  }
  end(chunk, encoding, cb) {
    if (this.blockRemain) {
      super.write(Buffer.alloc(this.blockRemain));
    }
    if (typeof chunk === "function") {
      cb = chunk;
      encoding = void 0;
      chunk = void 0;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (typeof chunk === "string") {
      chunk = Buffer.from(chunk, encoding ?? "utf8");
    }
    if (cb)
      this.once("finish", cb);
    chunk ? super.end(chunk, cb) : super.end(cb);
    return this;
  }
}
const getType = (stat) => stat.isFile() ? "File" : stat.isDirectory() ? "Directory" : stat.isSymbolicLink() ? "SymbolicLink" : "Unsupported";
class Yallist {
  tail;
  head;
  length = 0;
  static create(list2 = []) {
    return new Yallist(list2);
  }
  constructor(list2 = []) {
    for (const item of list2) {
      this.push(item);
    }
  }
  *[Symbol.iterator]() {
    for (let walker = this.head; walker; walker = walker.next) {
      yield walker.value;
    }
  }
  removeNode(node) {
    if (node.list !== this) {
      throw new Error("removing node which does not belong to this list");
    }
    const next = node.next;
    const prev = node.prev;
    if (next) {
      next.prev = prev;
    }
    if (prev) {
      prev.next = next;
    }
    if (node === this.head) {
      this.head = next;
    }
    if (node === this.tail) {
      this.tail = prev;
    }
    this.length--;
    node.next = void 0;
    node.prev = void 0;
    node.list = void 0;
    return next;
  }
  unshiftNode(node) {
    if (node === this.head) {
      return;
    }
    if (node.list) {
      node.list.removeNode(node);
    }
    const head = this.head;
    node.list = this;
    node.next = head;
    if (head) {
      head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
    this.length++;
  }
  pushNode(node) {
    if (node === this.tail) {
      return;
    }
    if (node.list) {
      node.list.removeNode(node);
    }
    const tail = this.tail;
    node.list = this;
    node.prev = tail;
    if (tail) {
      tail.next = node;
    }
    this.tail = node;
    if (!this.head) {
      this.head = node;
    }
    this.length++;
  }
  push(...args) {
    for (let i = 0, l = args.length; i < l; i++) {
      push(this, args[i]);
    }
    return this.length;
  }
  unshift(...args) {
    for (var i = 0, l = args.length; i < l; i++) {
      unshift(this, args[i]);
    }
    return this.length;
  }
  pop() {
    if (!this.tail) {
      return void 0;
    }
    const res = this.tail.value;
    const t = this.tail;
    this.tail = this.tail.prev;
    if (this.tail) {
      this.tail.next = void 0;
    } else {
      this.head = void 0;
    }
    t.list = void 0;
    this.length--;
    return res;
  }
  shift() {
    if (!this.head) {
      return void 0;
    }
    const res = this.head.value;
    const h = this.head;
    this.head = this.head.next;
    if (this.head) {
      this.head.prev = void 0;
    } else {
      this.tail = void 0;
    }
    h.list = void 0;
    this.length--;
    return res;
  }
  forEach(fn, thisp) {
    thisp = thisp || this;
    for (let walker = this.head, i = 0; !!walker; i++) {
      fn.call(thisp, walker.value, i, this);
      walker = walker.next;
    }
  }
  forEachReverse(fn, thisp) {
    thisp = thisp || this;
    for (let walker = this.tail, i = this.length - 1; !!walker; i--) {
      fn.call(thisp, walker.value, i, this);
      walker = walker.prev;
    }
  }
  get(n) {
    let i = 0;
    let walker = this.head;
    for (; !!walker && i < n; i++) {
      walker = walker.next;
    }
    if (i === n && !!walker) {
      return walker.value;
    }
  }
  getReverse(n) {
    let i = 0;
    let walker = this.tail;
    for (; !!walker && i < n; i++) {
      walker = walker.prev;
    }
    if (i === n && !!walker) {
      return walker.value;
    }
  }
  map(fn, thisp) {
    thisp = thisp || this;
    const res = new Yallist();
    for (let walker = this.head; !!walker; ) {
      res.push(fn.call(thisp, walker.value, this));
      walker = walker.next;
    }
    return res;
  }
  mapReverse(fn, thisp) {
    thisp = thisp || this;
    var res = new Yallist();
    for (let walker = this.tail; !!walker; ) {
      res.push(fn.call(thisp, walker.value, this));
      walker = walker.prev;
    }
    return res;
  }
  reduce(fn, initial) {
    let acc;
    let walker = this.head;
    if (arguments.length > 1) {
      acc = initial;
    } else if (this.head) {
      walker = this.head.next;
      acc = this.head.value;
    } else {
      throw new TypeError("Reduce of empty list with no initial value");
    }
    for (var i = 0; !!walker; i++) {
      acc = fn(acc, walker.value, i);
      walker = walker.next;
    }
    return acc;
  }
  reduceReverse(fn, initial) {
    let acc;
    let walker = this.tail;
    if (arguments.length > 1) {
      acc = initial;
    } else if (this.tail) {
      walker = this.tail.prev;
      acc = this.tail.value;
    } else {
      throw new TypeError("Reduce of empty list with no initial value");
    }
    for (let i = this.length - 1; !!walker; i--) {
      acc = fn(acc, walker.value, i);
      walker = walker.prev;
    }
    return acc;
  }
  toArray() {
    const arr = new Array(this.length);
    for (let i = 0, walker = this.head; !!walker; i++) {
      arr[i] = walker.value;
      walker = walker.next;
    }
    return arr;
  }
  toArrayReverse() {
    const arr = new Array(this.length);
    for (let i = 0, walker = this.tail; !!walker; i++) {
      arr[i] = walker.value;
      walker = walker.prev;
    }
    return arr;
  }
  slice(from = 0, to = this.length) {
    if (to < 0) {
      to += this.length;
    }
    if (from < 0) {
      from += this.length;
    }
    const ret = new Yallist();
    if (to < from || to < 0) {
      return ret;
    }
    if (from < 0) {
      from = 0;
    }
    if (to > this.length) {
      to = this.length;
    }
    let walker = this.head;
    let i = 0;
    for (i = 0; !!walker && i < from; i++) {
      walker = walker.next;
    }
    for (; !!walker && i < to; i++, walker = walker.next) {
      ret.push(walker.value);
    }
    return ret;
  }
  sliceReverse(from = 0, to = this.length) {
    if (to < 0) {
      to += this.length;
    }
    if (from < 0) {
      from += this.length;
    }
    const ret = new Yallist();
    if (to < from || to < 0) {
      return ret;
    }
    if (from < 0) {
      from = 0;
    }
    if (to > this.length) {
      to = this.length;
    }
    let i = this.length;
    let walker = this.tail;
    for (; !!walker && i > to; i--) {
      walker = walker.prev;
    }
    for (; !!walker && i > from; i--, walker = walker.prev) {
      ret.push(walker.value);
    }
    return ret;
  }
  splice(start, deleteCount = 0, ...nodes) {
    if (start > this.length) {
      start = this.length - 1;
    }
    if (start < 0) {
      start = this.length + start;
    }
    let walker = this.head;
    for (let i = 0; !!walker && i < start; i++) {
      walker = walker.next;
    }
    const ret = [];
    for (let i = 0; !!walker && i < deleteCount; i++) {
      ret.push(walker.value);
      walker = this.removeNode(walker);
    }
    if (!walker) {
      walker = this.tail;
    } else if (walker !== this.tail) {
      walker = walker.prev;
    }
    for (const v of nodes) {
      walker = insertAfter(this, walker, v);
    }
    return ret;
  }
  reverse() {
    const head = this.head;
    const tail = this.tail;
    for (let walker = head; !!walker; walker = walker.prev) {
      const p = walker.prev;
      walker.prev = walker.next;
      walker.next = p;
    }
    this.head = tail;
    this.tail = head;
    return this;
  }
}
function insertAfter(self, node, value) {
  const prev = node;
  const next = node ? node.next : self.head;
  const inserted = new Node(value, prev, next, self);
  if (inserted.next === void 0) {
    self.tail = inserted;
  }
  if (inserted.prev === void 0) {
    self.head = inserted;
  }
  self.length++;
  return inserted;
}
function push(self, item) {
  self.tail = new Node(item, self.tail, void 0, self);
  if (!self.head) {
    self.head = self.tail;
  }
  self.length++;
}
function unshift(self, item) {
  self.head = new Node(item, void 0, self.head, self);
  if (!self.tail) {
    self.tail = self.head;
  }
  self.length++;
}
class Node {
  list;
  next;
  prev;
  value;
  constructor(value, prev, next, list2) {
    this.list = list2;
    this.value = value;
    if (prev) {
      prev.next = this;
      this.prev = prev;
    } else {
      this.prev = void 0;
    }
    if (next) {
      next.prev = this;
      this.next = next;
    } else {
      this.next = void 0;
    }
  }
}
class PackJob {
  path;
  absolute;
  entry;
  stat;
  readdir;
  pending = false;
  ignore = false;
  piped = false;
  constructor(path, absolute) {
    this.path = path || "./";
    this.absolute = absolute;
  }
}
const EOF = Buffer.alloc(1024);
const ONSTAT = Symbol("onStat");
const ENDED$1 = Symbol("ended");
const QUEUE = Symbol("queue");
const CURRENT = Symbol("current");
const PROCESS = Symbol("process");
const PROCESSING = Symbol("processing");
const PROCESSJOB = Symbol("processJob");
const JOBS = Symbol("jobs");
const JOBDONE = Symbol("jobDone");
const ADDFSENTRY = Symbol("addFSEntry");
const ADDTARENTRY = Symbol("addTarEntry");
const STAT = Symbol("stat");
const READDIR = Symbol("readdir");
const ONREADDIR = Symbol("onreaddir");
const PIPE = Symbol("pipe");
const ENTRY = Symbol("entry");
const ENTRYOPT = Symbol("entryOpt");
const WRITEENTRYCLASS = Symbol("writeEntryClass");
const WRITE = Symbol("write");
const ONDRAIN = Symbol("ondrain");
class Pack extends Minipass {
  opt;
  cwd;
  maxReadSize;
  preservePaths;
  strict;
  noPax;
  prefix;
  linkCache;
  statCache;
  file;
  portable;
  zip;
  readdirCache;
  noDirRecurse;
  follow;
  noMtime;
  mtime;
  filter;
  jobs;
  [WRITEENTRYCLASS];
  onWriteEntry;
  // Note: we actually DO need a linked list here, because we
  // shift() to update the head of the list where we start, but still
  // while that happens, need to know what the next item in the queue
  // will be. Since we do multiple jobs in parallel, it's not as simple
  // as just an Array.shift(), since that would lose the information about
  // the next job in the list. We could add a .next field on the PackJob
  // class, but then we'd have to be tracking the tail of the queue the
  // whole time, and Yallist just does that for us anyway.
  [QUEUE];
  [JOBS] = 0;
  [PROCESSING] = false;
  [ENDED$1] = false;
  constructor(opt = {}) {
    super();
    this.opt = opt;
    this.file = opt.file || "";
    this.cwd = opt.cwd || process.cwd();
    this.maxReadSize = opt.maxReadSize;
    this.preservePaths = !!opt.preservePaths;
    this.strict = !!opt.strict;
    this.noPax = !!opt.noPax;
    this.prefix = normalizeWindowsPath(opt.prefix || "");
    this.linkCache = opt.linkCache || /* @__PURE__ */ new Map();
    this.statCache = opt.statCache || /* @__PURE__ */ new Map();
    this.readdirCache = opt.readdirCache || /* @__PURE__ */ new Map();
    this.onWriteEntry = opt.onWriteEntry;
    this[WRITEENTRYCLASS] = WriteEntry;
    if (typeof opt.onwarn === "function") {
      this.on("warn", opt.onwarn);
    }
    this.portable = !!opt.portable;
    if (opt.gzip || opt.brotli || opt.zstd) {
      if ((opt.gzip ? 1 : 0) + (opt.brotli ? 1 : 0) + (opt.zstd ? 1 : 0) > 1) {
        throw new TypeError("gzip, brotli, zstd are mutually exclusive");
      }
      if (opt.gzip) {
        if (typeof opt.gzip !== "object") {
          opt.gzip = {};
        }
        if (this.portable) {
          opt.gzip.portable = true;
        }
        this.zip = new Gzip(opt.gzip);
      }
      if (opt.brotli) {
        if (typeof opt.brotli !== "object") {
          opt.brotli = {};
        }
        this.zip = new BrotliCompress(opt.brotli);
      }
      if (opt.zstd) {
        if (typeof opt.zstd !== "object") {
          opt.zstd = {};
        }
        this.zip = new ZstdCompress(opt.zstd);
      }
      if (!this.zip)
        throw new Error("impossible");
      const zip = this.zip;
      zip.on("data", (chunk) => super.write(chunk));
      zip.on("end", () => super.end());
      zip.on("drain", () => this[ONDRAIN]());
      this.on("resume", () => zip.resume());
    } else {
      this.on("drain", this[ONDRAIN]);
    }
    this.noDirRecurse = !!opt.noDirRecurse;
    this.follow = !!opt.follow;
    this.noMtime = !!opt.noMtime;
    if (opt.mtime)
      this.mtime = opt.mtime;
    this.filter = typeof opt.filter === "function" ? opt.filter : () => true;
    this[QUEUE] = new Yallist();
    this[JOBS] = 0;
    this.jobs = Number(opt.jobs) || 4;
    this[PROCESSING] = false;
    this[ENDED$1] = false;
  }
  [WRITE](chunk) {
    return super.write(chunk);
  }
  add(path) {
    this.write(path);
    return this;
  }
  end(path, encoding, cb) {
    if (typeof path === "function") {
      cb = path;
      path = void 0;
    }
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = void 0;
    }
    if (path) {
      this.add(path);
    }
    this[ENDED$1] = true;
    this[PROCESS]();
    if (cb)
      cb();
    return this;
  }
  write(path) {
    if (this[ENDED$1]) {
      throw new Error("write after end");
    }
    if (path instanceof ReadEntry) {
      this[ADDTARENTRY](path);
    } else {
      this[ADDFSENTRY](path);
    }
    return this.flowing;
  }
  [ADDTARENTRY](p) {
    const absolute = normalizeWindowsPath(require$$0.resolve(this.cwd, p.path));
    if (!this.filter(p.path, p)) {
      p.resume();
    } else {
      const job = new PackJob(p.path, absolute);
      job.entry = new WriteEntryTar(p, this[ENTRYOPT](job));
      job.entry.on("end", () => this[JOBDONE](job));
      this[JOBS] += 1;
      this[QUEUE].push(job);
    }
    this[PROCESS]();
  }
  [ADDFSENTRY](p) {
    const absolute = normalizeWindowsPath(require$$0.resolve(this.cwd, p));
    this[QUEUE].push(new PackJob(p, absolute));
    this[PROCESS]();
  }
  [STAT](job) {
    job.pending = true;
    this[JOBS] += 1;
    const stat = this.follow ? "stat" : "lstat";
    fs[stat](job.absolute, (er, stat2) => {
      job.pending = false;
      this[JOBS] -= 1;
      if (er) {
        this.emit("error", er);
      } else {
        this[ONSTAT](job, stat2);
      }
    });
  }
  [ONSTAT](job, stat) {
    this.statCache.set(job.absolute, stat);
    job.stat = stat;
    if (!this.filter(job.path, stat)) {
      job.ignore = true;
    }
    this[PROCESS]();
  }
  [READDIR](job) {
    job.pending = true;
    this[JOBS] += 1;
    fs.readdir(job.absolute, (er, entries) => {
      job.pending = false;
      this[JOBS] -= 1;
      if (er) {
        return this.emit("error", er);
      }
      this[ONREADDIR](job, entries);
    });
  }
  [ONREADDIR](job, entries) {
    this.readdirCache.set(job.absolute, entries);
    job.readdir = entries;
    this[PROCESS]();
  }
  [PROCESS]() {
    if (this[PROCESSING]) {
      return;
    }
    this[PROCESSING] = true;
    for (let w = this[QUEUE].head; !!w && this[JOBS] < this.jobs; w = w.next) {
      this[PROCESSJOB](w.value);
      if (w.value.ignore) {
        const p = w.next;
        this[QUEUE].removeNode(w);
        w.next = p;
      }
    }
    this[PROCESSING] = false;
    if (this[ENDED$1] && !this[QUEUE].length && this[JOBS] === 0) {
      if (this.zip) {
        this.zip.end(EOF);
      } else {
        super.write(EOF);
        super.end();
      }
    }
  }
  get [CURRENT]() {
    return this[QUEUE] && this[QUEUE].head && this[QUEUE].head.value;
  }
  [JOBDONE](_job) {
    this[QUEUE].shift();
    this[JOBS] -= 1;
    this[PROCESS]();
  }
  [PROCESSJOB](job) {
    if (job.pending) {
      return;
    }
    if (job.entry) {
      if (job === this[CURRENT] && !job.piped) {
        this[PIPE](job);
      }
      return;
    }
    if (!job.stat) {
      const sc = this.statCache.get(job.absolute);
      if (sc) {
        this[ONSTAT](job, sc);
      } else {
        this[STAT](job);
      }
    }
    if (!job.stat) {
      return;
    }
    if (job.ignore) {
      return;
    }
    if (!this.noDirRecurse && job.stat.isDirectory() && !job.readdir) {
      const rc = this.readdirCache.get(job.absolute);
      if (rc) {
        this[ONREADDIR](job, rc);
      } else {
        this[READDIR](job);
      }
      if (!job.readdir) {
        return;
      }
    }
    job.entry = this[ENTRY](job);
    if (!job.entry) {
      job.ignore = true;
      return;
    }
    if (job === this[CURRENT] && !job.piped) {
      this[PIPE](job);
    }
  }
  [ENTRYOPT](job) {
    return {
      onwarn: (code2, msg, data) => this.warn(code2, msg, data),
      noPax: this.noPax,
      cwd: this.cwd,
      absolute: job.absolute,
      preservePaths: this.preservePaths,
      maxReadSize: this.maxReadSize,
      strict: this.strict,
      portable: this.portable,
      linkCache: this.linkCache,
      statCache: this.statCache,
      noMtime: this.noMtime,
      mtime: this.mtime,
      prefix: this.prefix,
      onWriteEntry: this.onWriteEntry
    };
  }
  [ENTRY](job) {
    this[JOBS] += 1;
    try {
      const e = new this[WRITEENTRYCLASS](job.path, this[ENTRYOPT](job));
      return e.on("end", () => this[JOBDONE](job)).on("error", (er) => this.emit("error", er));
    } catch (er) {
      this.emit("error", er);
    }
  }
  [ONDRAIN]() {
    if (this[CURRENT] && this[CURRENT].entry) {
      this[CURRENT].entry.resume();
    }
  }
  // like .pipe() but using super, because our write() is special
  [PIPE](job) {
    job.piped = true;
    if (job.readdir) {
      job.readdir.forEach((entry) => {
        const p = job.path;
        const base = p === "./" ? "" : p.replace(/\/*$/, "/");
        this[ADDFSENTRY](base + entry);
      });
    }
    const source = job.entry;
    const zip = this.zip;
    if (!source)
      throw new Error("cannot pipe without source");
    if (zip) {
      source.on("data", (chunk) => {
        if (!zip.write(chunk)) {
          source.pause();
        }
      });
    } else {
      source.on("data", (chunk) => {
        if (!super.write(chunk)) {
          source.pause();
        }
      });
    }
  }
  pause() {
    if (this.zip) {
      this.zip.pause();
    }
    return super.pause();
  }
  warn(code2, message, data = {}) {
    warnMethod(this, code2, message, data);
  }
}
class PackSync extends Pack {
  sync = true;
  constructor(opt) {
    super(opt);
    this[WRITEENTRYCLASS] = WriteEntrySync;
  }
  // pause/resume are no-ops in sync streams.
  pause() {
  }
  resume() {
  }
  [STAT](job) {
    const stat = this.follow ? "statSync" : "lstatSync";
    this[ONSTAT](job, fs[stat](job.absolute));
  }
  [READDIR](job) {
    this[ONREADDIR](job, fs.readdirSync(job.absolute));
  }
  // gotta get it all in this tick
  [PIPE](job) {
    const source = job.entry;
    const zip = this.zip;
    if (job.readdir) {
      job.readdir.forEach((entry) => {
        const p = job.path;
        const base = p === "./" ? "" : p.replace(/\/*$/, "/");
        this[ADDFSENTRY](base + entry);
      });
    }
    if (!source)
      throw new Error("Cannot pipe without source");
    if (zip) {
      source.on("data", (chunk) => {
        zip.write(chunk);
      });
    } else {
      source.on("data", (chunk) => {
        super[WRITE](chunk);
      });
    }
  }
}
const createFileSync = (opt, files) => {
  const p = new PackSync(opt);
  const stream = new WriteStreamSync(opt.file, {
    mode: opt.mode || 438
  });
  p.pipe(stream);
  addFilesSync$1(p, files);
};
const createFile = (opt, files) => {
  const p = new Pack(opt);
  const stream = new WriteStream(opt.file, {
    mode: opt.mode || 438
  });
  p.pipe(stream);
  const promise = new Promise((res, rej) => {
    stream.on("error", rej);
    stream.on("close", res);
    p.on("error", rej);
  });
  addFilesAsync$1(p, files);
  return promise;
};
const addFilesSync$1 = (p, files) => {
  files.forEach((file) => {
    if (file.charAt(0) === "@") {
      list({
        file: path__default.resolve(p.cwd, file.slice(1)),
        sync: true,
        noResume: true,
        onReadEntry: (entry) => p.add(entry)
      });
    } else {
      p.add(file);
    }
  });
  p.end();
};
const addFilesAsync$1 = async (p, files) => {
  for (let i = 0; i < files.length; i++) {
    const file = String(files[i]);
    if (file.charAt(0) === "@") {
      await list({
        file: path__default.resolve(String(p.cwd), file.slice(1)),
        noResume: true,
        onReadEntry: (entry) => {
          p.add(entry);
        }
      });
    } else {
      p.add(file);
    }
  }
  p.end();
};
const createSync = (opt, files) => {
  const p = new PackSync(opt);
  addFilesSync$1(p, files);
  return p;
};
const createAsync = (opt, files) => {
  const p = new Pack(opt);
  addFilesAsync$1(p, files);
  return p;
};
makeCommand(createFileSync, createFile, createSync, createAsync, (_opt, files) => {
  if (!files?.length) {
    throw new TypeError("no paths specified to add to archive");
  }
});
const platform$2 = process.env.__FAKE_PLATFORM__ || process.platform;
const isWindows$2 = platform$2 === "win32";
const { O_CREAT, O_TRUNC, O_WRONLY } = fs.constants;
const UV_FS_O_FILEMAP = Number(process.env.__FAKE_FS_O_FILENAME__) || fs.constants.UV_FS_O_FILEMAP || 0;
const fMapEnabled = isWindows$2 && !!UV_FS_O_FILEMAP;
const fMapLimit = 512 * 1024;
const fMapFlag = UV_FS_O_FILEMAP | O_TRUNC | O_CREAT | O_WRONLY;
const getWriteFlag = !fMapEnabled ? () => "w" : (size) => size < fMapLimit ? fMapFlag : "w";
const lchownSync = (path, uid, gid) => {
  try {
    return fs__default.lchownSync(path, uid, gid);
  } catch (er) {
    if (er?.code !== "ENOENT")
      throw er;
  }
};
const chown = (cpath, uid, gid, cb) => {
  fs__default.lchown(cpath, uid, gid, (er) => {
    cb(er && er?.code !== "ENOENT" ? er : null);
  });
};
const chownrKid = (p, child, uid, gid, cb) => {
  if (child.isDirectory()) {
    chownr(path__default.resolve(p, child.name), uid, gid, (er) => {
      if (er)
        return cb(er);
      const cpath = path__default.resolve(p, child.name);
      chown(cpath, uid, gid, cb);
    });
  } else {
    const cpath = path__default.resolve(p, child.name);
    chown(cpath, uid, gid, cb);
  }
};
const chownr = (p, uid, gid, cb) => {
  fs__default.readdir(p, { withFileTypes: true }, (er, children) => {
    if (er) {
      if (er.code === "ENOENT")
        return cb();
      else if (er.code !== "ENOTDIR" && er.code !== "ENOTSUP")
        return cb(er);
    }
    if (er || !children.length)
      return chown(p, uid, gid, cb);
    let len = children.length;
    let errState = null;
    const then = (er2) => {
      if (errState)
        return;
      if (er2)
        return cb(errState = er2);
      if (--len === 0)
        return chown(p, uid, gid, cb);
    };
    for (const child of children) {
      chownrKid(p, child, uid, gid, then);
    }
  });
};
const chownrKidSync = (p, child, uid, gid) => {
  if (child.isDirectory())
    chownrSync(path__default.resolve(p, child.name), uid, gid);
  lchownSync(path__default.resolve(p, child.name), uid, gid);
};
const chownrSync = (p, uid, gid) => {
  let children;
  try {
    children = fs__default.readdirSync(p, { withFileTypes: true });
  } catch (er) {
    const e = er;
    if (e?.code === "ENOENT")
      return;
    else if (e?.code === "ENOTDIR" || e?.code === "ENOTSUP")
      return lchownSync(p, uid, gid);
    else
      throw e;
  }
  for (const child of children) {
    chownrKidSync(p, child, uid, gid);
  }
  return lchownSync(p, uid, gid);
};
class CwdError extends Error {
  path;
  code;
  syscall = "chdir";
  constructor(path, code2) {
    super(`${code2}: Cannot cd into '${path}'`);
    this.path = path;
    this.code = code2;
  }
  get name() {
    return "CwdError";
  }
}
class SymlinkError extends Error {
  path;
  symlink;
  syscall = "symlink";
  code = "TAR_SYMLINK_ERROR";
  constructor(symlink, path) {
    super("TAR_SYMLINK_ERROR: Cannot extract through symbolic link");
    this.symlink = symlink;
    this.path = path;
  }
  get name() {
    return "SymlinkError";
  }
}
const checkCwd = (dir, cb) => {
  fs__default.stat(dir, (er, st) => {
    if (er || !st.isDirectory()) {
      er = new CwdError(dir, er?.code || "ENOTDIR");
    }
    cb(er);
  });
};
const mkdir = (dir, opt, cb) => {
  dir = normalizeWindowsPath(dir);
  const umask = opt.umask ?? 18;
  const mode = opt.mode | 448;
  const needChmod = (mode & umask) !== 0;
  const uid = opt.uid;
  const gid = opt.gid;
  const doChown = typeof uid === "number" && typeof gid === "number" && (uid !== opt.processUid || gid !== opt.processGid);
  const preserve = opt.preserve;
  const unlink = opt.unlink;
  const cwd = normalizeWindowsPath(opt.cwd);
  const done = (er, created) => {
    if (er) {
      cb(er);
    } else {
      if (created && doChown) {
        chownr(created, uid, gid, (er2) => done(er2));
      } else if (needChmod) {
        fs__default.chmod(dir, mode, cb);
      } else {
        cb();
      }
    }
  };
  if (dir === cwd) {
    return checkCwd(dir, done);
  }
  if (preserve) {
    return fsp.mkdir(dir, { mode, recursive: true }).then(
      (made) => done(null, made ?? void 0),
      // oh, ts
      done
    );
  }
  const sub = normalizeWindowsPath(path__default.relative(cwd, dir));
  const parts = sub.split("/");
  mkdir_(cwd, parts, mode, unlink, cwd, void 0, done);
};
const mkdir_ = (base, parts, mode, unlink, cwd, created, cb) => {
  if (!parts.length) {
    return cb(null, created);
  }
  const p = parts.shift();
  const part = normalizeWindowsPath(path__default.resolve(base + "/" + p));
  fs__default.mkdir(part, mode, onmkdir(part, parts, mode, unlink, cwd, created, cb));
};
const onmkdir = (part, parts, mode, unlink, cwd, created, cb) => (er) => {
  if (er) {
    fs__default.lstat(part, (statEr, st) => {
      if (statEr) {
        statEr.path = statEr.path && normalizeWindowsPath(statEr.path);
        cb(statEr);
      } else if (st.isDirectory()) {
        mkdir_(part, parts, mode, unlink, cwd, created, cb);
      } else if (unlink) {
        fs__default.unlink(part, (er2) => {
          if (er2) {
            return cb(er2);
          }
          fs__default.mkdir(part, mode, onmkdir(part, parts, mode, unlink, cwd, created, cb));
        });
      } else if (st.isSymbolicLink()) {
        return cb(new SymlinkError(part, part + "/" + parts.join("/")));
      } else {
        cb(er);
      }
    });
  } else {
    created = created || part;
    mkdir_(part, parts, mode, unlink, cwd, created, cb);
  }
};
const checkCwdSync = (dir) => {
  let ok = false;
  let code2 = void 0;
  try {
    ok = fs__default.statSync(dir).isDirectory();
  } catch (er) {
    code2 = er?.code;
  } finally {
    if (!ok) {
      throw new CwdError(dir, code2 ?? "ENOTDIR");
    }
  }
};
const mkdirSync = (dir, opt) => {
  dir = normalizeWindowsPath(dir);
  const umask = opt.umask ?? 18;
  const mode = opt.mode | 448;
  const needChmod = (mode & umask) !== 0;
  const uid = opt.uid;
  const gid = opt.gid;
  const doChown = typeof uid === "number" && typeof gid === "number" && (uid !== opt.processUid || gid !== opt.processGid);
  const preserve = opt.preserve;
  const unlink = opt.unlink;
  const cwd = normalizeWindowsPath(opt.cwd);
  const done = (created2) => {
    if (created2 && doChown) {
      chownrSync(created2, uid, gid);
    }
    if (needChmod) {
      fs__default.chmodSync(dir, mode);
    }
  };
  if (dir === cwd) {
    checkCwdSync(cwd);
    return done();
  }
  if (preserve) {
    return done(fs__default.mkdirSync(dir, { mode, recursive: true }) ?? void 0);
  }
  const sub = normalizeWindowsPath(path__default.relative(cwd, dir));
  const parts = sub.split("/");
  let created = void 0;
  for (let p = parts.shift(), part = cwd; p && (part += "/" + p); p = parts.shift()) {
    part = normalizeWindowsPath(path__default.resolve(part));
    try {
      fs__default.mkdirSync(part, mode);
      created = created || part;
    } catch (er) {
      const st = fs__default.lstatSync(part);
      if (st.isDirectory()) {
        continue;
      } else if (unlink) {
        fs__default.unlinkSync(part);
        fs__default.mkdirSync(part, mode);
        created = created || part;
        continue;
      } else if (st.isSymbolicLink()) {
        return new SymlinkError(part, part + "/" + parts.join("/"));
      }
    }
  }
  return done(created);
};
const normalizeCache = /* @__PURE__ */ Object.create(null);
const MAX = 1e4;
const cache = /* @__PURE__ */ new Set();
const normalizeUnicode = (s) => {
  if (!cache.has(s)) {
    normalizeCache[s] = s.normalize("NFD");
  } else {
    cache.delete(s);
  }
  cache.add(s);
  const ret = normalizeCache[s];
  let i = cache.size - MAX;
  if (i > MAX / 10) {
    for (const s2 of cache) {
      cache.delete(s2);
      delete normalizeCache[s2];
      if (--i <= 0)
        break;
    }
  }
  return ret;
};
const platform$1 = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
const isWindows$1 = platform$1 === "win32";
const getDirs = (path) => {
  const dirs = path.split("/").slice(0, -1).reduce((set, path2) => {
    const s = set[set.length - 1];
    if (s !== void 0) {
      path2 = join(s, path2);
    }
    set.push(path2 || "/");
    return set;
  }, []);
  return dirs;
};
class PathReservations {
  // path => [function or Set]
  // A Set object means a directory reservation
  // A fn is a direct reservation on that path
  #queues = /* @__PURE__ */ new Map();
  // fn => {paths:[path,...], dirs:[path, ...]}
  #reservations = /* @__PURE__ */ new Map();
  // functions currently running
  #running = /* @__PURE__ */ new Set();
  reserve(paths, fn) {
    paths = isWindows$1 ? ["win32 parallelization disabled"] : paths.map((p) => {
      return stripTrailingSlashes(join(normalizeUnicode(p))).toLowerCase();
    });
    const dirs = new Set(paths.map((path) => getDirs(path)).reduce((a, b) => a.concat(b)));
    this.#reservations.set(fn, { dirs, paths });
    for (const p of paths) {
      const q = this.#queues.get(p);
      if (!q) {
        this.#queues.set(p, [fn]);
      } else {
        q.push(fn);
      }
    }
    for (const dir of dirs) {
      const q = this.#queues.get(dir);
      if (!q) {
        this.#queues.set(dir, [/* @__PURE__ */ new Set([fn])]);
      } else {
        const l = q[q.length - 1];
        if (l instanceof Set) {
          l.add(fn);
        } else {
          q.push(/* @__PURE__ */ new Set([fn]));
        }
      }
    }
    return this.#run(fn);
  }
  // return the queues for each path the function cares about
  // fn => {paths, dirs}
  #getQueues(fn) {
    const res = this.#reservations.get(fn);
    if (!res) {
      throw new Error("function does not have any path reservations");
    }
    return {
      paths: res.paths.map((path) => this.#queues.get(path)),
      dirs: [...res.dirs].map((path) => this.#queues.get(path))
    };
  }
  // check if fn is first in line for all its paths, and is
  // included in the first set for all its dir queues
  check(fn) {
    const { paths, dirs } = this.#getQueues(fn);
    return paths.every((q) => q && q[0] === fn) && dirs.every((q) => q && q[0] instanceof Set && q[0].has(fn));
  }
  // run the function if it's first in line and not already running
  #run(fn) {
    if (this.#running.has(fn) || !this.check(fn)) {
      return false;
    }
    this.#running.add(fn);
    fn(() => this.#clear(fn));
    return true;
  }
  #clear(fn) {
    if (!this.#running.has(fn)) {
      return false;
    }
    const res = this.#reservations.get(fn);
    if (!res) {
      throw new Error("invalid reservation");
    }
    const { paths, dirs } = res;
    const next = /* @__PURE__ */ new Set();
    for (const path of paths) {
      const q = this.#queues.get(path);
      if (!q || q?.[0] !== fn) {
        continue;
      }
      const q0 = q[1];
      if (!q0) {
        this.#queues.delete(path);
        continue;
      }
      q.shift();
      if (typeof q0 === "function") {
        next.add(q0);
      } else {
        for (const f of q0) {
          next.add(f);
        }
      }
    }
    for (const dir of dirs) {
      const q = this.#queues.get(dir);
      const q0 = q?.[0];
      if (!q || !(q0 instanceof Set))
        continue;
      if (q0.size === 1 && q.length === 1) {
        this.#queues.delete(dir);
        continue;
      } else if (q0.size === 1) {
        q.shift();
        const n = q[0];
        if (typeof n === "function") {
          next.add(n);
        }
      } else {
        q0.delete(fn);
      }
    }
    this.#running.delete(fn);
    next.forEach((fn2) => this.#run(fn2));
    return true;
  }
}
const ONENTRY = Symbol("onEntry");
const CHECKFS = Symbol("checkFs");
const CHECKFS2 = Symbol("checkFs2");
const ISREUSABLE = Symbol("isReusable");
const MAKEFS = Symbol("makeFs");
const FILE = Symbol("file");
const DIRECTORY = Symbol("directory");
const LINK = Symbol("link");
const SYMLINK = Symbol("symlink");
const HARDLINK = Symbol("hardlink");
const UNSUPPORTED = Symbol("unsupported");
const CHECKPATH = Symbol("checkPath");
const MKDIR = Symbol("mkdir");
const ONERROR = Symbol("onError");
const PENDING = Symbol("pending");
const PEND = Symbol("pend");
const UNPEND = Symbol("unpend");
const ENDED = Symbol("ended");
const MAYBECLOSE = Symbol("maybeClose");
const SKIP = Symbol("skip");
const DOCHOWN = Symbol("doChown");
const UID = Symbol("uid");
const GID = Symbol("gid");
const CHECKED_CWD = Symbol("checkedCwd");
const platform = process.env.TESTING_TAR_FAKE_PLATFORM || process.platform;
const isWindows = platform === "win32";
const DEFAULT_MAX_DEPTH = 1024;
const unlinkFile = (path, cb) => {
  if (!isWindows) {
    return fs__default.unlink(path, cb);
  }
  const name2 = path + ".DELETE." + randomBytes(16).toString("hex");
  fs__default.rename(path, name2, (er) => {
    if (er) {
      return cb(er);
    }
    fs__default.unlink(name2, cb);
  });
};
const unlinkFileSync = (path) => {
  if (!isWindows) {
    return fs__default.unlinkSync(path);
  }
  const name2 = path + ".DELETE." + randomBytes(16).toString("hex");
  fs__default.renameSync(path, name2);
  fs__default.unlinkSync(name2);
};
const uint32 = (a, b, c) => a !== void 0 && a === a >>> 0 ? a : b !== void 0 && b === b >>> 0 ? b : c;
class Unpack extends Parser {
  [ENDED] = false;
  [CHECKED_CWD] = false;
  [PENDING] = 0;
  reservations = new PathReservations();
  transform;
  writable = true;
  readable = false;
  uid;
  gid;
  setOwner;
  preserveOwner;
  processGid;
  processUid;
  maxDepth;
  forceChown;
  win32;
  newer;
  keep;
  noMtime;
  preservePaths;
  unlink;
  cwd;
  strip;
  processUmask;
  umask;
  dmode;
  fmode;
  chmod;
  constructor(opt = {}) {
    opt.ondone = () => {
      this[ENDED] = true;
      this[MAYBECLOSE]();
    };
    super(opt);
    this.transform = opt.transform;
    this.chmod = !!opt.chmod;
    if (typeof opt.uid === "number" || typeof opt.gid === "number") {
      if (typeof opt.uid !== "number" || typeof opt.gid !== "number") {
        throw new TypeError("cannot set owner without number uid and gid");
      }
      if (opt.preserveOwner) {
        throw new TypeError("cannot preserve owner in archive and also set owner explicitly");
      }
      this.uid = opt.uid;
      this.gid = opt.gid;
      this.setOwner = true;
    } else {
      this.uid = void 0;
      this.gid = void 0;
      this.setOwner = false;
    }
    if (opt.preserveOwner === void 0 && typeof opt.uid !== "number") {
      this.preserveOwner = !!(process.getuid && process.getuid() === 0);
    } else {
      this.preserveOwner = !!opt.preserveOwner;
    }
    this.processUid = (this.preserveOwner || this.setOwner) && process.getuid ? process.getuid() : void 0;
    this.processGid = (this.preserveOwner || this.setOwner) && process.getgid ? process.getgid() : void 0;
    this.maxDepth = typeof opt.maxDepth === "number" ? opt.maxDepth : DEFAULT_MAX_DEPTH;
    this.forceChown = opt.forceChown === true;
    this.win32 = !!opt.win32 || isWindows;
    this.newer = !!opt.newer;
    this.keep = !!opt.keep;
    this.noMtime = !!opt.noMtime;
    this.preservePaths = !!opt.preservePaths;
    this.unlink = !!opt.unlink;
    this.cwd = normalizeWindowsPath(path__default.resolve(opt.cwd || process.cwd()));
    this.strip = Number(opt.strip) || 0;
    this.processUmask = !this.chmod ? 0 : typeof opt.processUmask === "number" ? opt.processUmask : process.umask();
    this.umask = typeof opt.umask === "number" ? opt.umask : this.processUmask;
    this.dmode = opt.dmode || 511 & ~this.umask;
    this.fmode = opt.fmode || 438 & ~this.umask;
    this.on("entry", (entry) => this[ONENTRY](entry));
  }
  // a bad or damaged archive is a warning for Parser, but an error
  // when extracting.  Mark those errors as unrecoverable, because
  // the Unpack contract cannot be met.
  warn(code2, msg, data = {}) {
    if (code2 === "TAR_BAD_ARCHIVE" || code2 === "TAR_ABORT") {
      data.recoverable = false;
    }
    return super.warn(code2, msg, data);
  }
  [MAYBECLOSE]() {
    if (this[ENDED] && this[PENDING] === 0) {
      this.emit("prefinish");
      this.emit("finish");
      this.emit("end");
    }
  }
  [CHECKPATH](entry) {
    const p = normalizeWindowsPath(entry.path);
    const parts = p.split("/");
    if (this.strip) {
      if (parts.length < this.strip) {
        return false;
      }
      if (entry.type === "Link") {
        const linkparts = normalizeWindowsPath(String(entry.linkpath)).split("/");
        if (linkparts.length >= this.strip) {
          entry.linkpath = linkparts.slice(this.strip).join("/");
        } else {
          return false;
        }
      }
      parts.splice(0, this.strip);
      entry.path = parts.join("/");
    }
    if (isFinite(this.maxDepth) && parts.length > this.maxDepth) {
      this.warn("TAR_ENTRY_ERROR", "path excessively deep", {
        entry,
        path: p,
        depth: parts.length,
        maxDepth: this.maxDepth
      });
      return false;
    }
    if (!this.preservePaths) {
      if (parts.includes("..") || /* c8 ignore next */
      isWindows && /^[a-z]:\.\.$/i.test(parts[0] ?? "")) {
        this.warn("TAR_ENTRY_ERROR", `path contains '..'`, {
          entry,
          path: p
        });
        return false;
      }
      const [root, stripped] = stripAbsolutePath(p);
      if (root) {
        entry.path = String(stripped);
        this.warn("TAR_ENTRY_INFO", `stripping ${root} from absolute path`, {
          entry,
          path: p
        });
      }
    }
    if (path__default.isAbsolute(entry.path)) {
      entry.absolute = normalizeWindowsPath(path__default.resolve(entry.path));
    } else {
      entry.absolute = normalizeWindowsPath(path__default.resolve(this.cwd, entry.path));
    }
    if (!this.preservePaths && typeof entry.absolute === "string" && entry.absolute.indexOf(this.cwd + "/") !== 0 && entry.absolute !== this.cwd) {
      this.warn("TAR_ENTRY_ERROR", "path escaped extraction target", {
        entry,
        path: normalizeWindowsPath(entry.path),
        resolvedPath: entry.absolute,
        cwd: this.cwd
      });
      return false;
    }
    if (entry.absolute === this.cwd && entry.type !== "Directory" && entry.type !== "GNUDumpDir") {
      return false;
    }
    if (this.win32) {
      const { root: aRoot } = path__default.win32.parse(String(entry.absolute));
      entry.absolute = aRoot + encode(String(entry.absolute).slice(aRoot.length));
      const { root: pRoot } = path__default.win32.parse(entry.path);
      entry.path = pRoot + encode(entry.path.slice(pRoot.length));
    }
    return true;
  }
  [ONENTRY](entry) {
    if (!this[CHECKPATH](entry)) {
      return entry.resume();
    }
    assert$1.equal(typeof entry.absolute, "string");
    switch (entry.type) {
      case "Directory":
      case "GNUDumpDir":
        if (entry.mode) {
          entry.mode = entry.mode | 448;
        }
      // eslint-disable-next-line no-fallthrough
      case "File":
      case "OldFile":
      case "ContiguousFile":
      case "Link":
      case "SymbolicLink":
        return this[CHECKFS](entry);
      case "CharacterDevice":
      case "BlockDevice":
      case "FIFO":
      default:
        return this[UNSUPPORTED](entry);
    }
  }
  [ONERROR](er, entry) {
    if (er.name === "CwdError") {
      this.emit("error", er);
    } else {
      this.warn("TAR_ENTRY_ERROR", er, { entry });
      this[UNPEND]();
      entry.resume();
    }
  }
  [MKDIR](dir, mode, cb) {
    mkdir(normalizeWindowsPath(dir), {
      uid: this.uid,
      gid: this.gid,
      processUid: this.processUid,
      processGid: this.processGid,
      umask: this.processUmask,
      preserve: this.preservePaths,
      unlink: this.unlink,
      cwd: this.cwd,
      mode
    }, cb);
  }
  [DOCHOWN](entry) {
    return this.forceChown || this.preserveOwner && (typeof entry.uid === "number" && entry.uid !== this.processUid || typeof entry.gid === "number" && entry.gid !== this.processGid) || typeof this.uid === "number" && this.uid !== this.processUid || typeof this.gid === "number" && this.gid !== this.processGid;
  }
  [UID](entry) {
    return uint32(this.uid, entry.uid, this.processUid);
  }
  [GID](entry) {
    return uint32(this.gid, entry.gid, this.processGid);
  }
  [FILE](entry, fullyDone) {
    const mode = typeof entry.mode === "number" ? entry.mode & 4095 : this.fmode;
    const stream = new WriteStream(String(entry.absolute), {
      // slight lie, but it can be numeric flags
      flags: getWriteFlag(entry.size),
      mode,
      autoClose: false
    });
    stream.on("error", (er) => {
      if (stream.fd) {
        fs__default.close(stream.fd, () => {
        });
      }
      stream.write = () => true;
      this[ONERROR](er, entry);
      fullyDone();
    });
    let actions = 1;
    const done = (er) => {
      if (er) {
        if (stream.fd) {
          fs__default.close(stream.fd, () => {
          });
        }
        this[ONERROR](er, entry);
        fullyDone();
        return;
      }
      if (--actions === 0) {
        if (stream.fd !== void 0) {
          fs__default.close(stream.fd, (er2) => {
            if (er2) {
              this[ONERROR](er2, entry);
            } else {
              this[UNPEND]();
            }
            fullyDone();
          });
        }
      }
    };
    stream.on("finish", () => {
      const abs = String(entry.absolute);
      const fd = stream.fd;
      if (typeof fd === "number" && entry.mtime && !this.noMtime) {
        actions++;
        const atime = entry.atime || /* @__PURE__ */ new Date();
        const mtime = entry.mtime;
        fs__default.futimes(fd, atime, mtime, (er) => er ? fs__default.utimes(abs, atime, mtime, (er2) => done(er2 && er)) : done());
      }
      if (typeof fd === "number" && this[DOCHOWN](entry)) {
        actions++;
        const uid = this[UID](entry);
        const gid = this[GID](entry);
        if (typeof uid === "number" && typeof gid === "number") {
          fs__default.fchown(fd, uid, gid, (er) => er ? fs__default.chown(abs, uid, gid, (er2) => done(er2 && er)) : done());
        }
      }
      done();
    });
    const tx = this.transform ? this.transform(entry) || entry : entry;
    if (tx !== entry) {
      tx.on("error", (er) => {
        this[ONERROR](er, entry);
        fullyDone();
      });
      entry.pipe(tx);
    }
    tx.pipe(stream);
  }
  [DIRECTORY](entry, fullyDone) {
    const mode = typeof entry.mode === "number" ? entry.mode & 4095 : this.dmode;
    this[MKDIR](String(entry.absolute), mode, (er) => {
      if (er) {
        this[ONERROR](er, entry);
        fullyDone();
        return;
      }
      let actions = 1;
      const done = () => {
        if (--actions === 0) {
          fullyDone();
          this[UNPEND]();
          entry.resume();
        }
      };
      if (entry.mtime && !this.noMtime) {
        actions++;
        fs__default.utimes(String(entry.absolute), entry.atime || /* @__PURE__ */ new Date(), entry.mtime, done);
      }
      if (this[DOCHOWN](entry)) {
        actions++;
        fs__default.chown(String(entry.absolute), Number(this[UID](entry)), Number(this[GID](entry)), done);
      }
      done();
    });
  }
  [UNSUPPORTED](entry) {
    entry.unsupported = true;
    this.warn("TAR_ENTRY_UNSUPPORTED", `unsupported entry type: ${entry.type}`, { entry });
    entry.resume();
  }
  [SYMLINK](entry, done) {
    this[LINK](entry, String(entry.linkpath), "symlink", done);
  }
  [HARDLINK](entry, done) {
    const linkpath = normalizeWindowsPath(path__default.resolve(this.cwd, String(entry.linkpath)));
    this[LINK](entry, linkpath, "link", done);
  }
  [PEND]() {
    this[PENDING]++;
  }
  [UNPEND]() {
    this[PENDING]--;
    this[MAYBECLOSE]();
  }
  [SKIP](entry) {
    this[UNPEND]();
    entry.resume();
  }
  // Check if we can reuse an existing filesystem entry safely and
  // overwrite it, rather than unlinking and recreating
  // Windows doesn't report a useful nlink, so we just never reuse entries
  [ISREUSABLE](entry, st) {
    return entry.type === "File" && !this.unlink && st.isFile() && st.nlink <= 1 && !isWindows;
  }
  // check if a thing is there, and if so, try to clobber it
  [CHECKFS](entry) {
    this[PEND]();
    const paths = [entry.path];
    if (entry.linkpath) {
      paths.push(entry.linkpath);
    }
    this.reservations.reserve(paths, (done) => this[CHECKFS2](entry, done));
  }
  [CHECKFS2](entry, fullyDone) {
    const done = (er) => {
      fullyDone(er);
    };
    const checkCwd2 = () => {
      this[MKDIR](this.cwd, this.dmode, (er) => {
        if (er) {
          this[ONERROR](er, entry);
          done();
          return;
        }
        this[CHECKED_CWD] = true;
        start();
      });
    };
    const start = () => {
      if (entry.absolute !== this.cwd) {
        const parent = normalizeWindowsPath(path__default.dirname(String(entry.absolute)));
        if (parent !== this.cwd) {
          return this[MKDIR](parent, this.dmode, (er) => {
            if (er) {
              this[ONERROR](er, entry);
              done();
              return;
            }
            afterMakeParent();
          });
        }
      }
      afterMakeParent();
    };
    const afterMakeParent = () => {
      fs__default.lstat(String(entry.absolute), (lstatEr, st) => {
        if (st && (this.keep || /* c8 ignore next */
        this.newer && st.mtime > (entry.mtime ?? st.mtime))) {
          this[SKIP](entry);
          done();
          return;
        }
        if (lstatEr || this[ISREUSABLE](entry, st)) {
          return this[MAKEFS](null, entry, done);
        }
        if (st.isDirectory()) {
          if (entry.type === "Directory") {
            const needChmod = this.chmod && entry.mode && (st.mode & 4095) !== entry.mode;
            const afterChmod = (er) => this[MAKEFS](er ?? null, entry, done);
            if (!needChmod) {
              return afterChmod();
            }
            return fs__default.chmod(String(entry.absolute), Number(entry.mode), afterChmod);
          }
          if (entry.absolute !== this.cwd) {
            return fs__default.rmdir(String(entry.absolute), (er) => this[MAKEFS](er ?? null, entry, done));
          }
        }
        if (entry.absolute === this.cwd) {
          return this[MAKEFS](null, entry, done);
        }
        unlinkFile(String(entry.absolute), (er) => this[MAKEFS](er ?? null, entry, done));
      });
    };
    if (this[CHECKED_CWD]) {
      start();
    } else {
      checkCwd2();
    }
  }
  [MAKEFS](er, entry, done) {
    if (er) {
      this[ONERROR](er, entry);
      done();
      return;
    }
    switch (entry.type) {
      case "File":
      case "OldFile":
      case "ContiguousFile":
        return this[FILE](entry, done);
      case "Link":
        return this[HARDLINK](entry, done);
      case "SymbolicLink":
        return this[SYMLINK](entry, done);
      case "Directory":
      case "GNUDumpDir":
        return this[DIRECTORY](entry, done);
    }
  }
  [LINK](entry, linkpath, link, done) {
    fs__default[link](linkpath, String(entry.absolute), (er) => {
      if (er) {
        this[ONERROR](er, entry);
      } else {
        this[UNPEND]();
        entry.resume();
      }
      done();
    });
  }
}
const callSync = (fn) => {
  try {
    return [null, fn()];
  } catch (er) {
    return [er, null];
  }
};
class UnpackSync extends Unpack {
  sync = true;
  [MAKEFS](er, entry) {
    return super[MAKEFS](er, entry, () => {
    });
  }
  [CHECKFS](entry) {
    if (!this[CHECKED_CWD]) {
      const er2 = this[MKDIR](this.cwd, this.dmode);
      if (er2) {
        return this[ONERROR](er2, entry);
      }
      this[CHECKED_CWD] = true;
    }
    if (entry.absolute !== this.cwd) {
      const parent = normalizeWindowsPath(path__default.dirname(String(entry.absolute)));
      if (parent !== this.cwd) {
        const mkParent = this[MKDIR](parent, this.dmode);
        if (mkParent) {
          return this[ONERROR](mkParent, entry);
        }
      }
    }
    const [lstatEr, st] = callSync(() => fs__default.lstatSync(String(entry.absolute)));
    if (st && (this.keep || /* c8 ignore next */
    this.newer && st.mtime > (entry.mtime ?? st.mtime))) {
      return this[SKIP](entry);
    }
    if (lstatEr || this[ISREUSABLE](entry, st)) {
      return this[MAKEFS](null, entry);
    }
    if (st.isDirectory()) {
      if (entry.type === "Directory") {
        const needChmod = this.chmod && entry.mode && (st.mode & 4095) !== entry.mode;
        const [er3] = needChmod ? callSync(() => {
          fs__default.chmodSync(String(entry.absolute), Number(entry.mode));
        }) : [];
        return this[MAKEFS](er3, entry);
      }
      const [er2] = callSync(() => fs__default.rmdirSync(String(entry.absolute)));
      this[MAKEFS](er2, entry);
    }
    const [er] = entry.absolute === this.cwd ? [] : callSync(() => unlinkFileSync(String(entry.absolute)));
    this[MAKEFS](er, entry);
  }
  [FILE](entry, done) {
    const mode = typeof entry.mode === "number" ? entry.mode & 4095 : this.fmode;
    const oner = (er) => {
      let closeError;
      try {
        fs__default.closeSync(fd);
      } catch (e) {
        closeError = e;
      }
      if (er || closeError) {
        this[ONERROR](er || closeError, entry);
      }
      done();
    };
    let fd;
    try {
      fd = fs__default.openSync(String(entry.absolute), getWriteFlag(entry.size), mode);
    } catch (er) {
      return oner(er);
    }
    const tx = this.transform ? this.transform(entry) || entry : entry;
    if (tx !== entry) {
      tx.on("error", (er) => this[ONERROR](er, entry));
      entry.pipe(tx);
    }
    tx.on("data", (chunk) => {
      try {
        fs__default.writeSync(fd, chunk, 0, chunk.length);
      } catch (er) {
        oner(er);
      }
    });
    tx.on("end", () => {
      let er = null;
      if (entry.mtime && !this.noMtime) {
        const atime = entry.atime || /* @__PURE__ */ new Date();
        const mtime = entry.mtime;
        try {
          fs__default.futimesSync(fd, atime, mtime);
        } catch (futimeser) {
          try {
            fs__default.utimesSync(String(entry.absolute), atime, mtime);
          } catch (utimeser) {
            er = futimeser;
          }
        }
      }
      if (this[DOCHOWN](entry)) {
        const uid = this[UID](entry);
        const gid = this[GID](entry);
        try {
          fs__default.fchownSync(fd, Number(uid), Number(gid));
        } catch (fchowner) {
          try {
            fs__default.chownSync(String(entry.absolute), Number(uid), Number(gid));
          } catch (chowner) {
            er = er || fchowner;
          }
        }
      }
      oner(er);
    });
  }
  [DIRECTORY](entry, done) {
    const mode = typeof entry.mode === "number" ? entry.mode & 4095 : this.dmode;
    const er = this[MKDIR](String(entry.absolute), mode);
    if (er) {
      this[ONERROR](er, entry);
      done();
      return;
    }
    if (entry.mtime && !this.noMtime) {
      try {
        fs__default.utimesSync(String(entry.absolute), entry.atime || /* @__PURE__ */ new Date(), entry.mtime);
      } catch (er2) {
      }
    }
    if (this[DOCHOWN](entry)) {
      try {
        fs__default.chownSync(String(entry.absolute), Number(this[UID](entry)), Number(this[GID](entry)));
      } catch (er2) {
      }
    }
    done();
    entry.resume();
  }
  [MKDIR](dir, mode) {
    try {
      return mkdirSync(normalizeWindowsPath(dir), {
        uid: this.uid,
        gid: this.gid,
        processUid: this.processUid,
        processGid: this.processGid,
        umask: this.processUmask,
        preserve: this.preservePaths,
        unlink: this.unlink,
        cwd: this.cwd,
        mode
      });
    } catch (er) {
      return er;
    }
  }
  [LINK](entry, linkpath, link, done) {
    const ls = `${link}Sync`;
    try {
      fs__default[ls](linkpath, String(entry.absolute));
      done();
      entry.resume();
    } catch (er) {
      return this[ONERROR](er, entry);
    }
  }
}
const extractFileSync = (opt) => {
  const u = new UnpackSync(opt);
  const file = opt.file;
  const stat = fs__default.statSync(file);
  const readSize = opt.maxReadSize || 16 * 1024 * 1024;
  const stream = new ReadStreamSync(file, {
    readSize,
    size: stat.size
  });
  stream.pipe(u);
};
const extractFile = (opt, _) => {
  const u = new Unpack(opt);
  const readSize = opt.maxReadSize || 16 * 1024 * 1024;
  const file = opt.file;
  const p = new Promise((resolve2, reject) => {
    u.on("error", reject);
    u.on("close", resolve2);
    fs__default.stat(file, (er, stat) => {
      if (er) {
        reject(er);
      } else {
        const stream = new ReadStream(file, {
          readSize,
          size: stat.size
        });
        stream.on("error", reject);
        stream.pipe(u);
      }
    });
  });
  return p;
};
const extract = makeCommand(extractFileSync, extractFile, (opt) => new UnpackSync(opt), (opt) => new Unpack(opt), (opt, files) => {
  if (files?.length)
    filesFilter(opt, files);
});
const replaceSync = (opt, files) => {
  const p = new PackSync(opt);
  let threw = true;
  let fd;
  let position;
  try {
    try {
      fd = fs__default.openSync(opt.file, "r+");
    } catch (er) {
      if (er?.code === "ENOENT") {
        fd = fs__default.openSync(opt.file, "w+");
      } else {
        throw er;
      }
    }
    const st = fs__default.fstatSync(fd);
    const headBuf = Buffer.alloc(512);
    POSITION: for (position = 0; position < st.size; position += 512) {
      for (let bufPos = 0, bytes = 0; bufPos < 512; bufPos += bytes) {
        bytes = fs__default.readSync(fd, headBuf, bufPos, headBuf.length - bufPos, position + bufPos);
        if (position === 0 && headBuf[0] === 31 && headBuf[1] === 139) {
          throw new Error("cannot append to compressed archives");
        }
        if (!bytes) {
          break POSITION;
        }
      }
      const h = new Header(headBuf);
      if (!h.cksumValid) {
        break;
      }
      const entryBlockSize = 512 * Math.ceil((h.size || 0) / 512);
      if (position + entryBlockSize + 512 > st.size) {
        break;
      }
      position += entryBlockSize;
      if (opt.mtimeCache && h.mtime) {
        opt.mtimeCache.set(String(h.path), h.mtime);
      }
    }
    threw = false;
    streamSync(opt, p, position, fd, files);
  } finally {
    if (threw) {
      try {
        fs__default.closeSync(fd);
      } catch (er) {
      }
    }
  }
};
const streamSync = (opt, p, position, fd, files) => {
  const stream = new WriteStreamSync(opt.file, {
    fd,
    start: position
  });
  p.pipe(stream);
  addFilesSync(p, files);
};
const replaceAsync = (opt, files) => {
  files = Array.from(files);
  const p = new Pack(opt);
  const getPos = (fd, size, cb_) => {
    const cb = (er, pos2) => {
      if (er) {
        fs__default.close(fd, (_) => cb_(er));
      } else {
        cb_(null, pos2);
      }
    };
    let position = 0;
    if (size === 0) {
      return cb(null, 0);
    }
    let bufPos = 0;
    const headBuf = Buffer.alloc(512);
    const onread = (er, bytes) => {
      if (er || typeof bytes === "undefined") {
        return cb(er);
      }
      bufPos += bytes;
      if (bufPos < 512 && bytes) {
        return fs__default.read(fd, headBuf, bufPos, headBuf.length - bufPos, position + bufPos, onread);
      }
      if (position === 0 && headBuf[0] === 31 && headBuf[1] === 139) {
        return cb(new Error("cannot append to compressed archives"));
      }
      if (bufPos < 512) {
        return cb(null, position);
      }
      const h = new Header(headBuf);
      if (!h.cksumValid) {
        return cb(null, position);
      }
      const entryBlockSize = 512 * Math.ceil((h.size ?? 0) / 512);
      if (position + entryBlockSize + 512 > size) {
        return cb(null, position);
      }
      position += entryBlockSize + 512;
      if (position >= size) {
        return cb(null, position);
      }
      if (opt.mtimeCache && h.mtime) {
        opt.mtimeCache.set(String(h.path), h.mtime);
      }
      bufPos = 0;
      fs__default.read(fd, headBuf, 0, 512, position, onread);
    };
    fs__default.read(fd, headBuf, 0, 512, position, onread);
  };
  const promise = new Promise((resolve2, reject) => {
    p.on("error", reject);
    let flag = "r+";
    const onopen = (er, fd) => {
      if (er && er.code === "ENOENT" && flag === "r+") {
        flag = "w+";
        return fs__default.open(opt.file, flag, onopen);
      }
      if (er || !fd) {
        return reject(er);
      }
      fs__default.fstat(fd, (er2, st) => {
        if (er2) {
          return fs__default.close(fd, () => reject(er2));
        }
        getPos(fd, st.size, (er3, position) => {
          if (er3) {
            return reject(er3);
          }
          const stream = new WriteStream(opt.file, {
            fd,
            start: position
          });
          p.pipe(stream);
          stream.on("error", reject);
          stream.on("close", resolve2);
          addFilesAsync(p, files);
        });
      });
    };
    fs__default.open(opt.file, flag, onopen);
  });
  return promise;
};
const addFilesSync = (p, files) => {
  files.forEach((file) => {
    if (file.charAt(0) === "@") {
      list({
        file: path__default.resolve(p.cwd, file.slice(1)),
        sync: true,
        noResume: true,
        onReadEntry: (entry) => p.add(entry)
      });
    } else {
      p.add(file);
    }
  });
  p.end();
};
const addFilesAsync = async (p, files) => {
  for (let i = 0; i < files.length; i++) {
    const file = String(files[i]);
    if (file.charAt(0) === "@") {
      await list({
        file: path__default.resolve(String(p.cwd), file.slice(1)),
        noResume: true,
        onReadEntry: (entry) => p.add(entry)
      });
    } else {
      p.add(file);
    }
  }
  p.end();
};
const replace = makeCommand(
  replaceSync,
  replaceAsync,
  /* c8 ignore start */
  () => {
    throw new TypeError("file is required");
  },
  () => {
    throw new TypeError("file is required");
  },
  /* c8 ignore stop */
  (opt, entries) => {
    if (!isFile(opt)) {
      throw new TypeError("file is required");
    }
    if (opt.gzip || opt.brotli || opt.zstd || opt.file.endsWith(".br") || opt.file.endsWith(".tbr")) {
      throw new TypeError("cannot append to compressed archives");
    }
    if (!entries?.length) {
      throw new TypeError("no paths specified to add/replace");
    }
  }
);
makeCommand(replace.syncFile, replace.asyncFile, replace.syncNoFile, replace.asyncNoFile, (opt, entries = []) => {
  replace.validate?.(opt, entries);
  mtimeFilter(opt);
});
const mtimeFilter = (opt) => {
  const filter = opt.filter;
  if (!opt.mtimeCache) {
    opt.mtimeCache = /* @__PURE__ */ new Map();
  }
  opt.filter = filter ? (path, stat) => filter(path, stat) && !/* c8 ignore start */
  ((opt.mtimeCache?.get(path) ?? stat.mtime ?? 0) > (stat.mtime ?? 0)) : (path, stat) => !/* c8 ignore start */
  ((opt.mtimeCache?.get(path) ?? stat.mtime ?? 0) > (stat.mtime ?? 0));
};
const tempDirectories = /* @__PURE__ */ new Set();
let cleanupHandlersRegistered = false;
function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  const cleanup = async () => {
    if (tempDirectories.size === 0) return;
    const dirs = Array.from(tempDirectories);
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
          tempDirectories.delete(dir);
        } catch (_error) {
        }
      })
    );
  };
  process.on("exit", () => {
  });
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", async (error) => {
    await cleanup();
    throw error;
  });
}
function parseGitUrl(url) {
  let host;
  let user;
  let repo;
  let ref = "HEAD";
  let subdir;
  if (url.startsWith("github:")) {
    host = "github";
    const parts = url.slice(7).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.startsWith("gitlab:")) {
    host = "gitlab";
    const parts = url.slice(7).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.startsWith("bitbucket:")) {
    host = "bitbucket";
    const parts = url.slice(10).split("/");
    user = parts[0];
    const repoAndRef = parts[1]?.split("#") || ["", ""];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];
    if (parts.length > 2) {
      subdir = parts.slice(2).join("/");
    }
  } else if (url.includes("github.com")) {
    host = "github";
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes("gitlab.com")) {
    host = "gitlab";
    const match = url.match(/gitlab\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitLab URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes("bitbucket.org")) {
    host = "bitbucket";
    const match = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid Bitbucket URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, "");
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(":");
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else {
    throw new Error(`Unsupported git URL: ${url}`);
  }
  return { host, user, repo, ref, subdir };
}
function getTarballUrl(repo) {
  switch (repo.host) {
    case "github":
      return `https://github.com/${repo.user}/${repo.repo}/archive/${repo.ref}.tar.gz`;
    case "gitlab":
      return `https://gitlab.com/${repo.user}/${repo.repo}/-/archive/${repo.ref}/${repo.repo}-${repo.ref}.tar.gz`;
    case "bitbucket":
      return `https://bitbucket.org/${repo.user}/${repo.repo}/get/${repo.ref}.tar.gz`;
    default:
      throw new Error(`Unsupported git host: ${repo.host}`);
  }
}
function validateRedirectUrl(redirectUrl) {
  try {
    const url = new URL(redirectUrl);
    if (url.protocol !== "https:") {
      throw new Error(
        `Invalid redirect protocol: ${url.protocol} (only https: allowed)`
      );
    }
    const trustedHosts = [
      "github.com",
      "www.github.com",
      "codeload.github.com",
      "gitlab.com",
      "www.gitlab.com",
      "bitbucket.org",
      "www.bitbucket.org"
    ];
    if (!trustedHosts.includes(url.hostname)) {
      throw new Error(`Redirect to untrusted host: ${url.hostname}`);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.startsWith("192.168.") || url.hostname.startsWith("10.") || url.hostname.startsWith("172.")) {
      throw new Error(
        `Redirect to internal/local address not allowed: ${url.hostname}`
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid redirect URL format: ${redirectUrl}`);
    }
    throw error;
  }
}
async function downloadTarball(url, dest) {
  const REQUEST_TIMEOUT = 3e4;
  const MAX_TARBALL_SIZE = 100 * 1024 * 1024;
  return new Promise((resolve2, reject) => {
    let timedOut = false;
    let receivedBytes = 0;
    const req = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          return reject(new Error("Redirect without location header"));
        }
        try {
          validateRedirectUrl(redirectUrl);
        } catch (error) {
          return reject(error);
        }
        return downloadTarball(redirectUrl, dest).then(resolve2, reject);
      }
      if (response.statusCode !== 200) {
        return reject(
          new Error(`Failed to download tarball: HTTP ${response.statusCode}`)
        );
      }
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_TARBALL_SIZE) {
          response.destroy(new Error("Tarball size exceeds limit"));
        }
      });
      const extractStream = extract({
        cwd: dest,
        strip: 1
        // Remove top-level directory from tarball
      });
      response.pipe(extractStream);
      extractStream.on("finish", () => resolve2(dest));
      extractStream.on("error", (err) => {
        response.destroy();
        reject(err);
      });
    });
    req.setTimeout(REQUEST_TIMEOUT, () => {
      timedOut = true;
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", (err) => {
      if (timedOut) {
        reject(new Error("Request timed out"));
      } else {
        reject(err);
      }
    });
  });
}
async function loadGitTemplate(gitUrl) {
  registerCleanupHandlers();
  const repo = parseGitUrl(gitUrl);
  const tempDir = join(
    tmpdir(),
    `smrt-template-${repo.user}-${repo.repo}-${Date.now()}`
  );
  await mkdir$1(tempDir, { recursive: true });
  tempDirectories.add(tempDir);
  try {
    const tarballUrl = getTarballUrl(repo);
    console.log(
      `Downloading template from ${repo.host}:${repo.user}/${repo.repo}...`
    );
    await downloadTarball(tarballUrl, tempDir);
    const templateDir = repo.subdir ? join(tempDir, repo.subdir) : tempDir;
    const configPath = join(templateDir, "template.config.js");
    try {
      const configUrl = pathToFileURL(configPath).href;
      const module2 = await import(configUrl);
      const config = module2.default || module2;
      validateTemplateConfig$2(config, configPath);
      config.__tempDir = tempDir;
      return config;
    } catch (_error) {
      try {
        const tsConfigPath = join(templateDir, "template.config.ts");
        const configUrl = pathToFileURL(tsConfigPath).href;
        const module2 = await import(configUrl);
        const config = module2.default || module2;
        validateTemplateConfig$2(config, tsConfigPath);
        config.__tempDir = tempDir;
        return config;
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${gitUrl}`
        );
      }
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
async function cleanupGitTemplate(config) {
  const tempDir = config.__tempDir;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
function validateTemplateConfig$2(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
function expandHomeDirectory(path) {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}
function validateResolvedPath(absolutePath, originalPath) {
  const home = homedir();
  if (absolutePath.includes("\0") || originalPath.includes("\0")) {
    throw new Error(
      "Path contains null bytes (potential path traversal attempt)"
    );
  }
  if (originalPath.startsWith("~")) {
    const normalizedPath2 = resolve(absolutePath);
    const normalizedHome = resolve(home);
    if (!normalizedPath2.startsWith(normalizedHome)) {
      throw new Error(
        `Path traversal detected: resolved path "${normalizedPath2}" escapes home directory "${normalizedHome}"`
      );
    }
  }
  const sensitivePaths = [
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/var/log"
  ];
  const normalizedPath = resolve(absolutePath);
  for (const sensitivePath of sensitivePaths) {
    if (normalizedPath === sensitivePath || normalizedPath.startsWith(`${sensitivePath}/`)) {
      throw new Error(
        `Access to sensitive system directory not allowed: ${sensitivePath}`
      );
    }
  }
  if (normalizedPath.startsWith("/bin/") || normalizedPath.startsWith("/sbin/") || normalizedPath.startsWith("/usr/bin/") || normalizedPath.startsWith("/usr/sbin/")) {
    throw new Error("Access to system binary directories not allowed");
  }
}
async function resolveLocalPath(localPath) {
  let absolutePath;
  if (localPath.startsWith("~")) {
    absolutePath = expandHomeDirectory(localPath);
  } else if (localPath.startsWith("/")) {
    absolutePath = localPath;
  } else {
    absolutePath = resolve(process.cwd(), localPath);
  }
  validateResolvedPath(absolutePath, localPath);
  try {
    await access(absolutePath);
  } catch {
    throw new Error(`Local template path does not exist: ${absolutePath}`);
  }
  return absolutePath;
}
async function loadLocalTemplate(resolvedPath) {
  let configPath = null;
  for (const ext of ["js", "ts"]) {
    const testPath = join(resolvedPath, `template.config.${ext}`);
    try {
      await access(testPath);
      configPath = testPath;
      break;
    } catch {
    }
  }
  if (!configPath) {
    throw new Error(
      `No template.config.js or template.config.ts found in ${resolvedPath}`
    );
  }
  try {
    const configUrl = pathToFileURL(configPath).href;
    const module2 = await import(configUrl);
    const config = module2.default || module2;
    validateTemplateConfig$1(config, configPath);
    return config;
  } catch (error) {
    throw new Error(
      `Failed to load template config from ${configPath}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
function validateTemplateConfig$1(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
async function resolveNpmPackage(packagePath) {
  try {
    const resolved = require.resolve(packagePath, {
      paths: [process.cwd(), ...module.paths]
    });
    return resolved;
  } catch {
    const nodeModulesPath = join(process.cwd(), "node_modules", packagePath);
    try {
      await access(nodeModulesPath);
      return nodeModulesPath;
    } catch {
      throw new Error(
        `npm package '${packagePath}' not found. Install with: npm install ${packagePath.split("/")[0]}`
      );
    }
  }
}
async function loadNpmTemplate(resolvedPath) {
  let configPath;
  if (resolvedPath.endsWith("template.config.js") || resolvedPath.endsWith("template.config.ts")) {
    configPath = resolvedPath;
  } else {
    const dir = resolvedPath.endsWith(".js") ? dirname$1(resolvedPath) : resolvedPath;
    try {
      configPath = join(dir, "template.config.js");
      await access(configPath);
    } catch {
      try {
        configPath = join(dir, "template.config.ts");
        await access(configPath);
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${dir}`
        );
      }
    }
  }
  try {
    const configUrl = pathToFileURL(configPath).href;
    const module2 = await import(configUrl);
    const config = module2.default || module2;
    validateTemplateConfig(config, configPath);
    return config;
  } catch (error) {
    throw new Error(
      `Failed to load template config from ${configPath}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
async function findTemplateInPackages(shortName) {
  const nodeModulesPath = join(process.cwd(), "node_modules");
  const patterns = [
    // Scoped packages with templates directory
    `${nodeModulesPath}/@*/templates/${shortName}/template.config.{js,ts}`,
    // Scoped packages direct
    `${nodeModulesPath}/@*/${shortName}/template.config.{js,ts}`,
    // Unscoped packages
    `${nodeModulesPath}/${shortName}/template.config.{js,ts}`,
    // Templates subdirectory in any package
    `${nodeModulesPath}/*/templates/${shortName}/template.config.{js,ts}`
  ];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });
    if (matches.length > 0) {
      const configPath = matches[0];
      return dirname$1(configPath);
    }
  }
  return null;
}
async function discoverInstalledTemplates() {
  const nodeModulesPath = join(process.cwd(), "node_modules");
  const patterns = [
    `${nodeModulesPath}/@*/templates/*/template.config.{js,ts}`,
    `${nodeModulesPath}/*/template.config.{js,ts}`
  ];
  const templates = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });
    for (const configPath of matches) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module2 = await import(configUrl);
        const config = module2.default || module2;
        const relativePath = configPath.replace(nodeModulesPath + "/", "");
        const source = relativePath.substring(
          0,
          relativePath.indexOf("/template.config")
        );
        templates.push({
          name: config.name || "unknown",
          source,
          config
        });
      } catch (error) {
        console.warn(`Failed to load template at ${configPath}:`, error);
      }
    }
  }
  return templates;
}
function validateTemplateConfig(config, source) {
  const required = ["name", "description", "dependencies"];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`
      );
    }
  }
  if (typeof config.dependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`
    );
  }
  if (config.devDependencies && typeof config.devDependencies !== "object") {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`
    );
  }
}
async function resolveTemplate(name2) {
  if (name2.startsWith("github:") || name2.startsWith("gitlab:") || name2.startsWith("git@") || name2.endsWith(".git") || name2.startsWith("https://github.com") || name2.startsWith("https://gitlab.com")) {
    return {
      type: "git",
      location: name2,
      resolved: name2
    };
  }
  if (name2.startsWith("/") || name2.startsWith(".") || name2.startsWith("~")) {
    return {
      type: "local",
      location: name2,
      resolved: await resolveLocalPath(name2)
    };
  }
  if (name2.includes("@") || name2.includes("/")) {
    return {
      type: "npm",
      location: name2,
      resolved: await resolveNpmPackage(name2)
    };
  }
  const npmPath = await findTemplateInPackages(name2);
  if (npmPath) {
    return {
      type: "npm",
      location: npmPath,
      resolved: await resolveNpmPackage(npmPath)
    };
  }
  throw new Error(
    `Template '${name2}' not found. Tried:
  - npm package: @*/${name2}, @*/templates/${name2}
  - local path: ./${name2}, ../${name2}

Use one of:
  - npm package: @org/pkg/templates/name
  - git repo: github:user/repo
  - local path: ../path/to/template`
  );
}
async function loadTemplate(source) {
  switch (source.type) {
    case "npm":
      return loadNpmTemplate(source.resolved);
    case "git":
      return loadGitTemplate(source.resolved);
    case "local":
      return loadLocalTemplate(source.resolved);
    default:
      throw new Error(`Unknown template type: ${source.type}`);
  }
}
async function generate(source, config, options) {
  console.log(`
🏗️  Creating gnode: ${options.name}`);
  console.log(`📦 Using template: ${config.name} (${config.description})
`);
  if (config.baseGenerator) {
    console.log(`📝 Running base generator (${config.framework})...`);
    await runBaseGenerator(config.baseGenerator, options.outputDir);
  } else {
    await mkdir$1(options.outputDir, { recursive: true });
  }
  console.log("📋 Copying template files...");
  await overlayTemplate(source, config, options.outputDir);
  console.log("🔧 Configuring package.json...");
  await mergePackageJson(options.outputDir, config, options.name);
  console.log("\n✅ Gnode created successfully!");
  console.log(`
📍 Next steps:`);
  console.log(`   cd ${options.name}`);
  console.log(`   pnpm install`);
  console.log(`   pnpm dev
`);
}
function validateBaseGenerator(baseGen, outputDir) {
  const allowedCommands = ["npm", "npx", "pnpm", "yarn", "bun", "bunx"];
  if (!allowedCommands.includes(baseGen.command)) {
    throw new Error(
      `Base generator command "${baseGen.command}" not allowed. Allowed commands: ${allowedCommands.join(", ")}`
    );
  }
  const dangerousChars = /[;&|`$(){}[\]<>'"\\]/;
  if (dangerousChars.test(outputDir)) {
    throw new Error(
      `Output directory contains dangerous characters: ${outputDir}. Only alphanumeric, dash, underscore, dot, and forward slash are allowed.`
    );
  }
  for (const arg of baseGen.args) {
    const replacedArg = arg.replace("{DIR}", outputDir);
    if (dangerousChars.test(replacedArg)) {
      throw new Error(
        `Base generator argument contains dangerous characters after placeholder replacement: ${replacedArg}`
      );
    }
  }
}
async function runBaseGenerator(baseGen, outputDir) {
  validateBaseGenerator(baseGen, outputDir);
  const args = baseGen.args.map((arg) => arg.replace("{DIR}", outputDir));
  return new Promise((resolve2, reject) => {
    const proc2 = spawn(baseGen.command, args, {
      stdio: "inherit",
      shell: false
    });
    proc2.on("close", (code2) => {
      if (code2 === 0) {
        resolve2();
      } else {
        reject(new Error(`Base generator exited with code ${code2}`));
      }
    });
    proc2.on("error", reject);
  });
}
async function overlayTemplate(source, config, outputDir) {
  let overlayDir;
  switch (source.type) {
    case "npm":
      overlayDir = join(dirname$1(source.resolved), "overlay");
      break;
    case "git": {
      const tempDir = config.__tempDir;
      if (!tempDir) {
        throw new Error("Git template temp directory not found");
      }
      overlayDir = join(tempDir, "overlay");
      break;
    }
    case "local":
      overlayDir = join(source.resolved, "overlay");
      break;
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
  const files = await glob("**/*", {
    cwd: overlayDir,
    dot: true,
    onlyFiles: true
  });
  for (const file of files) {
    const src = join(overlayDir, file);
    const dest = join(outputDir, file);
    await mkdir$1(dirname$1(dest), { recursive: true });
    await cp(src, dest);
  }
}
async function mergePackageJson(outputDir, config, projectName) {
  const pkgPath = join(outputDir, "package.json");
  let pkg;
  try {
    const content = await readFile(pkgPath, "utf-8");
    pkg = JSON.parse(content);
  } catch {
    pkg = {
      name: projectName,
      version: "0.1.0",
      private: true,
      scripts: {},
      dependencies: {},
      devDependencies: {}
    };
  }
  pkg.name = projectName;
  pkg.dependencies = {
    ...pkg.dependencies,
    ...config.dependencies
  };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    ...config.devDependencies
  };
  if (!pkg.scripts["workflow:research"]) {
    pkg.scripts = {
      ...pkg.scripts,
      "workflow:research": "tsx src/workflows/research.ts",
      "workflow:report": "tsx src/workflows/report.ts"
    };
  }
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
const gnodeCommands = {
  "gnode create": {
    name: "gnode create",
    description: "Create a new gnode from template",
    args: ["name"],
    options: {
      template: {
        type: "string",
        description: "Template to use (npm package, git repo, or local path)",
        default: "sveltekit"
      },
      "output-dir": {
        type: "string",
        description: "Output directory (defaults to ./<name>)"
      }
    },
    handler: async (args, options) => {
      const name2 = args[0];
      if (!name2) {
        throw new Error("Project name is required: smrt gnode create <name>");
      }
      const outputDir = options.outputDir || `./${name2}`;
      const templateName = options.template || "sveltekit";
      try {
        console.log(`🔍 Resolving template: ${templateName}...`);
        const source = await resolveTemplate(templateName);
        console.log(`✓ Found template: ${source.type}:${source.location}
`);
        const config = await loadTemplate(source);
        await generate(source, config, {
          name: name2,
          template: templateName,
          outputDir
        });
        if (source.type === "git") {
          await cleanupGitTemplate(config);
        }
      } catch (error) {
        throw new Error(
          `Failed to create gnode: ${error instanceof Error ? error.message : "Unknown error"}`,
          { cause: error }
        );
      }
    }
  },
  "gnode list-templates": {
    name: "gnode list-templates",
    description: "List available gnode templates",
    aliases: ["gnode ls"],
    handler: async (_args, _options) => {
      console.log("📦 Discovering installed templates...\n");
      const templates = await discoverInstalledTemplates();
      if (templates.length === 0) {
        console.log("No templates found in node_modules.");
        console.log(
          "\nTo use a template, install a package that provides one:"
        );
        console.log("  npm install @happyvertical/praeco");
        console.log("\nOr use a git repository:");
        console.log("  smrt gnode create my-town --template=github:user/repo");
        return;
      }
      console.log("Available templates:\n");
      for (const t of templates) {
        console.log(`  ${t.name}`);
        console.log(`    ${t.config.description}`);
        console.log(`    Source: ${t.source}`);
        console.log(`    Framework: ${t.config.framework || "unknown"}`);
        console.log();
      }
      console.log(`Found ${templates.length} template(s)
`);
      console.log("Usage:");
      console.log("  smrt gnode create <name> --template=<template-name>");
      console.log("  smrt gnode create my-town --template=sveltekit");
    }
  }
};
export {
  generateCommands,
  gnodeCommands
};
//# sourceMappingURL=index-CEGpQ-x1.js.map
