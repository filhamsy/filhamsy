/**
 * Raw WebGL 1 / GLSL ES 1.00.
 *
 * The portrait liquifies into the butterfly in its final position, then its
 * color and surrounding artwork reveal outward. Timing and displacement
 * depend only on scroll progress, so the sequence also plays backward.
 * Vector masks pack sharp coverage in G and pre-blurred goo in R; each is
 * rasterized once at load. The foreground mark stays outside the shader.
 *
 * Progress 0-0.15 and 0.96-1.0 return exact, unshaded endpoints.
 */

export const vertexShaderSource = /* glsl */ `
  precision highp float;

  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const fragmentShaderSource = /* glsl */ `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  varying vec2 v_uv;

  uniform vec2 u_resolution;
  uniform float u_progress;
  uniform float u_reduced;
  uniform float u_portrait_aspect;
  uniform float u_butterfly_aspect;
  uniform sampler2D u_portrait;
  uniform sampler2D u_butterfly;
  uniform sampler2D u_portrait_mask;
  uniform sampler2D u_butterfly_mask;

  vec2 coverUv(vec2 uv, float textureAspect) {
    float screenAspect = u_resolution.x / u_resolution.y;
    vec2 ratio;
    if (screenAspect > textureAspect) {
      ratio = vec2(1.0, textureAspect / screenAspect);
    } else {
      ratio = vec2(screenAspect / textureAspect, 1.0);
    }
    return (uv - 0.5) * ratio + 0.5;
  }

  vec2 portraitUvAt(vec2 uv) {
    // Place the head's focal point at the same center as the foreground mark.
    return coverUv(uv, u_portrait_aspect) + vec2(0.015, 0.07);
  }

  float plateHeight() {
    float screenAspect = u_resolution.x / u_resolution.y;
    return min(0.90, 0.94 * screenAspect / u_butterfly_aspect);
  }

  vec2 plateUv(vec2 uv) {
    float screenAspect = u_resolution.x / u_resolution.y;
    float height = plateHeight();
    float width = height * u_butterfly_aspect / screenAspect;
    return (uv - 0.5) / vec2(width, height) + 0.5;
  }

  float rectMask(vec2 tileUv) {
    vec2 edge = min(tileUv, 1.0 - tileUv);
    vec2 mask = smoothstep(vec2(0.0), vec2(0.0014), edge);
    return mask.x * mask.y;
  }

  vec3 artworkSurround(vec2 uv) {
    vec2 tile = plateUv(uv);
    // Fold a narrow perimeter strip, never the butterfly, into the margins.
    // Reflection joins the original plate continuously and retains its grain.
    vec2 outside = max(-tile, tile - 1.0);
    vec2 folded = 0.025 * (1.0 - abs(mod(max(outside, 0.0) / 0.025, 2.0) - 1.0));
    // Scramble distant samples so the narrow strip does not form wallpaper.
    vec2 pixel = floor(gl_FragCoord.xy);
    vec2 random = fract(sin(vec2(
      dot(pixel, vec2(127.1, 311.7)),
      dot(pixel, vec2(269.5, 183.3))
    )) * 43758.5453);
    vec2 scatter = smoothstep(vec2(0.0), vec2(0.04), outside);
    folded = mix(folded, random * 0.025, scatter);
    vec2 source = clamp(tile, 0.0, 1.0);
    if (tile.x < 0.0) source.x = folded.x;
    if (tile.x > 1.0) source.x = 1.0 - folded.x;
    if (tile.y < 0.0) source.y = folded.y;
    if (tile.y > 1.0) source.y = 1.0 - folded.y;
    source += (random - 0.5) * vec2(scatter.y, scatter.x) * 0.012;
    source = clamp(source, 0.0, 1.0);
    return texture2D(u_butterfly, source).rgb;
  }

  vec3 portraitScene(vec2 uv) {
    return texture2D(u_portrait, portraitUvAt(uv)).rgb;
  }

  vec3 finalScene(vec2 uv) {
    vec2 tileUv = plateUv(uv);
    vec3 plate = texture2D(u_butterfly, clamp(tileUv, 0.0, 1.0)).rgb;
    return mix(artworkSurround(uv), plate, rectMask(tileUv));
  }

  vec2 butterflyMaskUv(vec2 tile) {
    // Register SVG viewBox (55,410,600,320) to the 709x1075 original.
    // Texture UVs are bottom-up, unlike source pixel coordinates.
    return (tile - vec2(55.0 / 709.0, 345.0 / 1075.0)) /
      vec2(600.0 / 709.0, 320.0 / 1075.0);
  }

  vec3 metamorphosis(vec2 uv, float p) {
    vec3 paper = vec3(0.975, 0.972, 0.965);

    // Continue directly from the colored butterfly into outward coverage.
    // The artwork and butterfly stay registered; only the reveal mask scales.
    if (p >= 0.56) {
      float spread = smoothstep(0.56, 0.96, p);
      vec2 tile = plateUv(uv);
      vec2 maskUv = butterflyMaskUv(tile);
      vec2 body = vec2(0.5, 0.56);
      vec2 revealUv = body + (maskUv - body) / exp2(4.5 * spread);
      vec2 revealField =
        texture2D(u_butterfly_mask, clamp(revealUv, 0.0, 1.0)).rg *
        rectMask(revealUv);
      float softness = smoothstep(0.0, 0.25, spread) * 0.8;
      float reveal = smoothstep(
        0.15, 0.85, mix(revealField.g, revealField.r, softness)
      );
      reveal = mix(reveal, 1.0, smoothstep(0.92, 0.96, p));

      vec3 ground = artworkSurround(uv);
      vec3 artwork = texture2D(u_butterfly, clamp(tile, 0.0, 1.0)).rgb;
      return mix(paper, mix(ground, artwork, rectMask(tile)), reveal);
    }

    float shapeT = smoothstep(0.20, 0.54, p);
    float goo = smoothstep(0.16, 0.32, p) *
      (1.0 - smoothstep(0.42, 0.56, p));
    float pull = smoothstep(0.18, 0.34, p);
    float landscape = smoothstep(0.85, 1.65, u_resolution.x / u_resolution.y);
    vec2 centered = uv - vec2(0.5, 0.52);
    float bleed = pull * mix(0.08, 0.48, landscape);
    float wave = sin(uv.y * 12.0 + p * 7.0) * 0.05 * goo;
    vec2 domain =
      centered * vec2(1.0 - bleed + wave, 1.0) + vec2(0.5, 0.52);
    vec2 flow = vec2(
      sin(uv.y * 9.0 + p * 6.0),
      sin(uv.x * 8.0 - p * 5.0)
    ) * 0.035;
    flow += vec2(-centered.y, centered.x) *
      sin(length(centered) * 11.0 - p * 7.0) * 0.14;
    domain += flow * goo;

    // Gather the shoulders into the butterfly's fixed wing field.
    float lower = 1.0 - smoothstep(0.36, 0.66, uv.y);
    float gather = smoothstep(0.22, 0.52, p) * lower;
    domain.x = 0.5 + (domain.x - 0.5) * (1.0 + 1.2 * gather);
    domain.y = 0.52 + (domain.y - 0.52) / (1.0 - 0.65 * gather);
    domain.x += sin(uv.y * 10.0 + p * 6.0) * 0.09 * gather;
    vec2 foot = vec2(
      (domain.x - 0.5) / 0.54,
      min(domain.y - 0.26, 0.0) / 0.22
    );
    float roundedInk = 1.0 - smoothstep(0.88, 1.10, length(foot));
    float bounds = mix(1.0, roundedInk, smoothstep(0.20, 0.36, p));
    vec2 portraitUv = portraitUvAt(clamp(domain, 0.0, 1.0));
    vec3 portrait = mix(paper, texture2D(u_portrait, portraitUv).rgb, bounds);
    vec2 portraitField = texture2D(u_portrait_mask, portraitUv).rg * bounds;

    // Target the same registered mask that starts the outward reveal.
    vec2 wingUv = butterflyMaskUv(plateUv(uv));
    vec2 wingField = texture2D(u_butterfly_mask, clamp(wingUv, 0.0, 1.0)).rg *
      rectMask(wingUv);
    float portraitInk = mix(portraitField.g, portraitField.r, goo);
    float wingInk = mix(wingField.g, wingField.r, goo * 0.65);
    float field = mix(portraitInk, wingInk, shapeT);
    float threshold = mix(0.44, 0.48, shapeT) -
      0.16 * sin(shapeT * 3.14159265);
    float band = mix(0.035, 0.13, goo);
    float coverage = mix(
      smoothstep(threshold - band, threshold + band, field),
      smoothstep(0.15, 0.85, wingField.g),
      smoothstep(0.48, 0.56, p)
    );
    vec3 pigment = mix(portrait, vec3(0.018, 0.022, 0.030), shapeT);
    pigment = mix(pigment, finalScene(uv), smoothstep(0.36, 0.56, p));
    vec3 sculpted = mix(paper, pigment, coverage);
    return clamp(
      mix(portrait, sculpted, smoothstep(0.16, 0.28, p)), 0.0, 1.0
    );
  }

  void main() {
    vec2 uv = v_uv;
    float progress = clamp(u_progress, 0.0, 1.0);

    // Exact, artifact-free endpoints.
    if (progress <= 0.15) {
      gl_FragColor = vec4(portraitScene(uv), 1.0);
      return;
    }
    if (progress >= 0.96) {
      gl_FragColor = vec4(finalScene(uv), 1.0);
      return;
    }

    if (u_reduced > 0.5) {
      float dissolve = smoothstep(0.15, 0.90, progress);
      gl_FragColor = vec4(mix(portraitScene(uv), finalScene(uv), dissolve), 1.0);
      return;
    }

    gl_FragColor = vec4(metamorphosis(uv, progress), 1.0);
  }
`;
