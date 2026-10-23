import { fragmentShaderSource, vertexShaderSource } from './shaders';

export interface ArtworkSources {
  portrait: string;
  portraitSilhouette: string;
  butterfly: string;
  butterflySilhouette: string;
}

interface PreparedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

interface UniformLocations {
  resolution: WebGLUniformLocation;
  progress: WebGLUniformLocation;
  reduced: WebGLUniformLocation;
  portraitAspect: WebGLUniformLocation;
  butterflyAspect: WebGLUniformLocation;
  portrait: WebGLUniformLocation;
  butterfly: WebGLUniformLocation;
  portraitMask: WebGLUniformLocation;
  butterflyMask: WebGLUniformLocation;
}

const MAX_DPR = 2;
const MAX_COARSE_DPR = 1.75;
const MAX_CANVAS_PIXELS = 8_500_000;
const MAX_TEXTURE_EDGE = 2048;
const COARSE_TEXTURE_EDGE = 1600;
const MASK_BLUR_RATIO = 0.02;

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load artwork: ${source}`));
    image.src = source;
  });
}

function prepareImage(
  image: HTMLImageElement,
  maxEdge: number,
): PreparedImage {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('A 2D context is required to prepare texture data.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);

  return { canvas, width, height };
}

function prepareGooMask(image: PreparedImage): PreparedImage {
  // Both inputs are vector-derived coverage, retained at texture resolution.
  const { width, height } = image;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('A 2D context is required to prepare the gooey mask.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const inkCanvas = image.canvas;
  const inkContext = inkCanvas.getContext('2d');
  if (!inkContext) {
    throw new Error('A 2D context is required to extract the ink field.');
  }
  const pixels = inkContext.getImageData(0, 0, width, height);

  // No ink beyond the image boundary.
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);

  const blurPx = Math.max(2, width * MASK_BLUR_RATIO);
  context.filter = `blur(${blurPx.toFixed(2)}px)`;

  if (context.filter !== 'none') {
    context.drawImage(inkCanvas, 0, 0, width, height);
    context.filter = 'none';
  } else {
    // Canvas filters unavailable: soften by resampling through a tiny canvas.
    const scratch = document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(width / 6));
    scratch.height = Math.max(1, Math.round(height / 6));
    const scratchContext = scratch.getContext('2d', { alpha: false });
    if (scratchContext) {
      scratchContext.imageSmoothingEnabled = true;
      scratchContext.imageSmoothingQuality = 'high';
      scratchContext.drawImage(
        inkCanvas,
        0,
        0,
        scratch.width,
        scratch.height,
      );
      context.drawImage(scratch, 0, 0, width, height);
    } else {
      context.drawImage(inkCanvas, 0, 0, width, height);
    }
  }

  // R carries blurred goo, G the antialiased vector boundary. Packing both
  // avoids another GPU texture, binding, or fragment texture sample.
  const packed = context.getImageData(0, 0, width, height);
  for (let i = 0; i < packed.data.length; i += 4) {
    packed.data[i + 1] = pixels.data[i];
  }
  context.putImageData(packed, 0, 0);

  return { canvas, width, height };
}

export class ArtworkRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;

  private program: WebGLProgram | null = null;
  private vertices: WebGLBuffer | null = null;
  private portraitTexture: WebGLTexture | null = null;
  private butterflyTexture: WebGLTexture | null = null;
  private portraitMaskTexture: WebGLTexture | null = null;
  private butterflyMaskTexture: WebGLTexture | null = null;
  private uniforms: UniformLocations | null = null;
  private positionAttribute = -1;

  private progress = 0;
  private reducedMotion = false;
  private ready = false;
  private disposed = false;
  private scheduledFrame = 0;

  private viewportWidth = 0;
  private viewportHeight = 0;
  private portraitAspect = 4 / 3;
  private butterflyAspect = 709 / 1075;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const attributes: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    };

    const gl = canvas.getContext('webgl', attributes);
    if (!gl) {
      throw new Error('WebGL is unavailable.');
    }

    this.gl = gl;
    this.buildProgram();
    this.buildGeometry();
  }

  get isReady(): boolean {
    return this.ready && !this.disposed;
  }

  async load(sources: ArtworkSources): Promise<void> {
    if (this.disposed) {
      return;
    }

    const [
      portraitImage,
      butterflyImage,
      silhouetteImage,
      butterflySilhouetteImage,
    ] = await Promise.all([
      loadImage(sources.portrait),
      loadImage(sources.butterfly),
      loadImage(sources.portraitSilhouette),
      loadImage(sources.butterflySilhouette),
    ]);

    if (this.disposed || this.gl.isContextLost()) {
      return;
    }

    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const maxTextureSize = Number(
      this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
    );
    const portraitEdge = Math.min(
      maxTextureSize,
      coarsePointer ? COARSE_TEXTURE_EDGE : MAX_TEXTURE_EDGE,
    );
    const butterflyEdge = Math.min(maxTextureSize, MAX_TEXTURE_EDGE);

    const portrait = prepareImage(portraitImage, portraitEdge);
    const butterfly = prepareImage(butterflyImage, butterflyEdge);
    const silhouette = prepareImage(silhouetteImage, portraitEdge);
    const butterflySilhouette = prepareImage(
      butterflySilhouetteImage,
      butterflyEdge,
    );

    this.portraitAspect = portrait.width / portrait.height;
    this.butterflyAspect = butterfly.width / butterfly.height;

    const portraitMask = prepareGooMask(silhouette);
    const butterflyMask = prepareGooMask(butterflySilhouette);

    this.portraitTexture = this.createTexture(portrait);
    this.butterflyTexture = this.createTexture(butterfly);
    this.portraitMaskTexture = this.createTexture(portraitMask);
    this.butterflyMaskTexture = this.createTexture(butterflyMask);
    this.ready = true;
  }

  setProgress(progress: number): void {
    const next = Math.min(1, Math.max(0, progress));
    if (Math.abs(next - this.progress) < 0.00001) {
      return;
    }
    this.progress = next;
    this.requestRender();
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) {
      return;
    }
    this.reducedMotion = reduced;
    this.requestRender();
  }

  requestRender(): void {
    if (!this.ready || this.disposed || this.scheduledFrame !== 0) {
      return;
    }
    this.scheduledFrame = window.requestAnimationFrame(() => {
      this.scheduledFrame = 0;
      this.renderNow();
    });
  }

  renderNow(): void {
    if (!this.ready || this.disposed) {
      return;
    }

    const gl = this.gl;
    const program = this.program;
    const uniforms = this.uniforms;
    const vertices = this.vertices;
    const portraitTexture = this.portraitTexture;
    const butterflyTexture = this.butterflyTexture;
    const portraitMaskTexture = this.portraitMaskTexture;
    const butterflyMaskTexture = this.butterflyMaskTexture;

    if (
      gl.isContextLost() ||
      !program ||
      !uniforms ||
      !vertices ||
      !portraitTexture ||
      !butterflyTexture ||
      !portraitMaskTexture ||
      !butterflyMaskTexture
    ) {
      return;
    }

    this.resize();

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.012, 0.014, 0.017, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    gl.uniform2f(
      uniforms.resolution,
      this.viewportWidth,
      this.viewportHeight,
    );
    gl.uniform1f(uniforms.progress, this.progress);
    gl.uniform1f(uniforms.reduced, this.reducedMotion ? 1 : 0);
    gl.uniform1f(uniforms.portraitAspect, this.portraitAspect);
    gl.uniform1f(uniforms.butterflyAspect, this.butterflyAspect);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, portraitTexture);
    gl.uniform1i(uniforms.portrait, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, butterflyTexture);
    gl.uniform1i(uniforms.butterfly, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, portraitMaskTexture);
    gl.uniform1i(uniforms.portraitMask, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, butterflyMaskTexture);
    gl.uniform1i(uniforms.butterflyMask, 3);

    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.enableVertexAttribArray(this.positionAttribute);
    gl.vertexAttribPointer(
      this.positionAttribute,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.ready = false;

    if (this.scheduledFrame !== 0) {
      window.cancelAnimationFrame(this.scheduledFrame);
      this.scheduledFrame = 0;
    }

    const gl = this.gl;
    if (!gl.isContextLost()) {
      if (this.portraitTexture) {
        gl.deleteTexture(this.portraitTexture);
      }
      if (this.butterflyTexture) {
        gl.deleteTexture(this.butterflyTexture);
      }
      if (this.portraitMaskTexture) {
        gl.deleteTexture(this.portraitMaskTexture);
      }
      if (this.butterflyMaskTexture) {
        gl.deleteTexture(this.butterflyMaskTexture);
      }
      if (this.vertices) {
        gl.deleteBuffer(this.vertices);
      }
      if (this.program) {
        gl.deleteProgram(this.program);
      }
    }

    this.portraitTexture = null;
    this.butterflyTexture = null;
    this.portraitMaskTexture = null;
    this.butterflyMaskTexture = null;
    this.vertices = null;
    this.program = null;
    this.uniforms = null;
  }

  private resize(): void {
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const dprCap = coarsePointer ? MAX_COARSE_DPR : MAX_DPR;

    let scale = Math.min(window.devicePixelRatio || 1, dprCap);
    let width = Math.max(1, Math.round(rect.width * scale));
    let height = Math.max(1, Math.round(rect.height * scale));

    const pixels = width * height;
    if (pixels > MAX_CANVAS_PIXELS) {
      const correction = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      width = Math.max(1, Math.round(width * correction));
      height = Math.max(1, Math.round(height * correction));
    }

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (width !== this.viewportWidth || height !== this.viewportHeight) {
      this.viewportWidth = width;
      this.viewportHeight = height;
      gl.viewport(0, 0, width, height);
    }
  }

  private buildProgram(): void {
    const gl = this.gl;
    const vertex = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragment = this.compileShader(
      gl.FRAGMENT_SHADER,
      fragmentShaderSource,
    );

    const program = gl.createProgram();
    if (!program) {
      throw new Error('Unable to allocate a WebGL program.');
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'Unknown link error.';
      gl.deleteProgram(program);
      throw new Error(`WebGL program failed to link: ${log}`);
    }

    this.program = program;
    this.positionAttribute = gl.getAttribLocation(program, 'a_position');
    if (this.positionAttribute < 0) {
      throw new Error('The artwork vertex attribute could not be located.');
    }

    const uniform = (name: string): WebGLUniformLocation => {
      const location = gl.getUniformLocation(program, name);
      if (!location) {
        throw new Error(`The artwork uniform "${name}" is missing.`);
      }
      return location;
    };

    this.uniforms = {
      resolution: uniform('u_resolution'),
      progress: uniform('u_progress'),
      reduced: uniform('u_reduced'),
      portraitAspect: uniform('u_portrait_aspect'),
      butterflyAspect: uniform('u_butterfly_aspect'),
      portrait: uniform('u_portrait'),
      butterfly: uniform('u_butterfly'),
      portraitMask: uniform('u_portrait_mask'),
      butterflyMask: uniform('u_butterfly_mask'),
    };
  }

  private buildGeometry(): void {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error('Unable to allocate the artwork geometry.');
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    this.vertices = buffer;
  }

  private createTexture(image: PreparedImage): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error('Unable to allocate an artwork texture.');
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      image.canvas,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    return texture;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('Unable to allocate a WebGL shader.');
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'Unknown compile error.';
      gl.deleteShader(shader);
      throw new Error(`WebGL shader failed to compile: ${log}`);
    }

    return shader;
  }
}
