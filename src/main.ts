import './style.css';
import { ArtworkRenderer } from './art-renderer';

const assetUrl = (file: string): string =>
  `${import.meta.env.BASE_URL}assets/${file}`;

const portraitSource = assetUrl('portrait-hi.jpg');
const butterflySource = assetUrl('butterfly-art.webp');
const fallbackAlternates: Record<string, string> = {
  portrait: 'portrait-hi.jpg',
  butterfly: 'butterfly-art.webp',
};

const root = document.documentElement;

const canvasElement = document.getElementById('art-canvas');
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('The artwork canvas is missing.');
}

const stageStatusNode = document.getElementById('stage-status');
if (!(stageStatusNode instanceof HTMLParagraphElement)) {
  throw new Error('The artwork status element is missing.');
}

const canvas = canvasElement;
const stageStatus = stageStatusNode;

const stageElement: HTMLElement =
  canvas.closest<HTMLElement>('.stage') ?? document.body;

const reducedMotionQuery = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
);

let renderer: ArtworkRenderer | null = null;
let rendererGeneration = 0;
let progress = 0;
let scrollFrame = 0;
let gpuActive = false;
let shaderState: 'loading' | 'ready' | 'unavailable' | 'lost' = 'loading';
const fallbackImages = document.querySelectorAll<HTMLImageElement>(
  '.fallback img',
);
const failedFallbackImages = new Set<HTMLImageElement>();

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function refreshStatus(): void {
  let message = '';

  if (gpuActive) {
    message = '';
  } else if (failedFallbackImages.size >= 2) {
    message = 'Artwork imagery unavailable';
  } else if (failedFallbackImages.size === 1) {
    message = 'One artwork image unavailable';
  } else if (shaderState === 'lost') {
    message = 'Shader paused — static image sequence';
  } else if (shaderState === 'unavailable') {
    message = 'Static image sequence — shader unavailable';
  }

  stageStatus.textContent = message;
  stageStatus.hidden = message.length === 0;
}

function getMaximumScroll(): number {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function readProgress(): number {
  return clamp(window.scrollY / getMaximumScroll());
}

function update(): void {
  progress = readProgress();

  // HTML image fallback: a plain, reversible dissolve that also serves as the
  // no-WebGL and context-loss experience.
  stageElement.style.setProperty(
    '--fb-portrait',
    (1 - smoothstep(0.34, 0.8, progress)).toFixed(4),
  );
  stageElement.style.setProperty(
    '--fb-butterfly',
    smoothstep(0.3, 0.72, progress).toFixed(4),
  );
  stageElement.style.setProperty(
    '--fb-surface',
    smoothstep(0.18, 0.64, progress).toFixed(4),
  );

  renderer?.setProgress(progress);
}

function scheduleUpdate(): void {
  if (scrollFrame !== 0) {
    return;
  }
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    update();
  });
}

function handleResize(): void {
  renderer?.requestRender();
  scheduleUpdate();
}

function wireFallbackImages(): void {
  fallbackImages.forEach((image) => {
    const asset = image.dataset.asset;
    const alternate = asset ? fallbackAlternates[asset] : undefined;
    const markFailed = (): void => {
      if (image.dataset.retried !== 'true' && alternate) {
        image.dataset.retried = 'true';
        image.src = assetUrl(alternate);
        return;
      }

      if (failedFallbackImages.has(image)) {
        return;
      }
      failedFallbackImages.add(image);
      image.hidden = true;
      refreshStatus();
    };

    image.addEventListener('error', markFailed);
    if (image.complete && image.naturalWidth === 0) {
      markFailed();
    }
  });

  const markImage = document.querySelector<HTMLImageElement>('.mark img');
  if (markImage) {
    const hideMark = (): void => {
      markImage.hidden = true;
    };
    markImage.addEventListener('error', hideMark);
    if (markImage.complete && markImage.naturalWidth === 0) {
      hideMark();
    }
  }
}

async function initialiseRenderer(): Promise<void> {
  const generation = ++rendererGeneration;

  root.classList.remove('gpu-ready');
  gpuActive = false;
  shaderState = 'loading';
  refreshStatus();

  const previous = renderer;
  renderer = null;
  previous?.dispose();

  let next: ArtworkRenderer | null = null;

  try {
    const instance = new ArtworkRenderer(canvas);
    next = instance;

    await instance.load({
      portrait: portraitSource,
      portraitSilhouette: assetUrl('portrait-silhouette.svg'),
      butterfly: butterflySource,
      butterflySilhouette: assetUrl('butterfly-silhouette.svg'),
    });

    if (generation !== rendererGeneration) {
      instance.dispose();
      return;
    }

    if (!instance.isReady) {
      instance.dispose();
      root.classList.add('webgl-off');
      shaderState = 'unavailable';
      refreshStatus();
      return;
    }

    instance.setReducedMotion(reducedMotionQuery.matches);
    instance.setProgress(progress);
    instance.renderNow();
    renderer = instance;
    gpuActive = true;
    shaderState = 'ready';
    refreshStatus();

    window.requestAnimationFrame(() => {
      if (generation === rendererGeneration && renderer === instance) {
        root.classList.add('gpu-ready');
        root.classList.remove('webgl-off', 'context-lost');
      }
    });
  } catch (error) {
    next?.dispose();

    if (generation !== rendererGeneration) {
      return;
    }

    console.warn(
      '[FILHAMSY] WebGL renderer unavailable. The scroll-linked image dissolve remains active.',
      error,
    );
    root.classList.remove('gpu-ready');
    root.classList.add('webgl-off');
    gpuActive = false;
    shaderState = 'unavailable';
    refreshStatus();
  }
}

function wireContextRecovery(): void {
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      rendererGeneration += 1;

      const lost = renderer;
      renderer = null;
      lost?.dispose();

      gpuActive = false;
      shaderState = 'lost';
      refreshStatus();

      root.classList.remove('gpu-ready');
      root.classList.add('context-lost');
      update();
    },
    false,
  );

  canvas.addEventListener(
    'webglcontextrestored',
    () => {
      root.classList.remove('context-lost', 'webgl-off');
      shaderState = 'loading';
      refreshStatus();
      void initialiseRenderer();
    },
    false,
  );
}

// A 16-second ping-pong cycle: 8 seconds forward, 8 seconds back.
const AUTOPLAY_DURATION_MS = 8_000;
let autoplayAllowed = !reducedMotionQuery.matches;
let autoplayFrame = 0;
let previousAutoplayTime = 0;
let autoplayPhase = readProgress();

function stopAutoplay(): void {
  autoplayAllowed = false;
  window.cancelAnimationFrame(autoplayFrame);
  autoplayFrame = 0;
  previousAutoplayTime = 0;
}

function advanceAutoplay(time: number): void {
  autoplayFrame = 0;
  if (!autoplayAllowed || document.hidden) {
    previousAutoplayTime = 0;
    return;
  }
  const elapsed = previousAutoplayTime === 0 ? 0 : time - previousAutoplayTime;
  previousAutoplayTime = time;
  autoplayPhase = (autoplayPhase + elapsed / AUTOPLAY_DURATION_MS) % 2;
  const next = autoplayPhase <= 1 ? autoplayPhase : 2 - autoplayPhase;
  window.scrollTo({ top: next * getMaximumScroll(), behavior: 'instant' });
  update();
  autoplayFrame = window.requestAnimationFrame(advanceAutoplay);
}

function resumeAutoplay(): void {
  if (autoplayAllowed && !document.hidden && autoplayFrame === 0) {
    autoplayFrame = window.requestAnimationFrame(advanceAutoplay);
  }
}

window.addEventListener('wheel', stopAutoplay, { passive: true });
window.addEventListener('touchstart', stopAutoplay, { passive: true });
window.addEventListener('pointerdown', stopAutoplay, { passive: true });
window.addEventListener('keydown', (event) => {
  if (
    ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(
      event.key,
    )
  ) {
    stopAutoplay();
  }
});

reducedMotionQuery.addEventListener('change', () => {
  renderer?.setReducedMotion(reducedMotionQuery.matches);
  if (reducedMotionQuery.matches) {
    stopAutoplay();
  }
});

window.addEventListener('scroll', scheduleUpdate, { passive: true });
window.addEventListener('resize', handleResize, { passive: true });
window.visualViewport?.addEventListener('resize', handleResize, {
  passive: true,
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderer?.requestRender();
    scheduleUpdate();
    resumeAutoplay();
  } else {
    window.cancelAnimationFrame(autoplayFrame);
    autoplayFrame = 0;
    previousAutoplayTime = 0;
  }
});

wireFallbackImages();
wireContextRecovery();

update();
void initialiseRenderer().finally(resumeAutoplay);
