// orb.js: a small WebGL orb with two eyes that follow the pointer. No framework.
// Ported from the LiveOrb component. The engine is unchanged apart from types.
// mount(el, opts) adds a canvas and a CSS fallback face, and follows the page theme.
// Frames draw only while the canvas is on screen and the tab is visible.
// Under reduced motion it holds one still frame.

export const WHITE = { color: "#F4F4F5", eyeColor: "#09090B" };
export const BLACK = { color: "#18181B", eyeColor: "#F4F4F5" };
export const CUSTOM_DEFAULT = { color: "#7C5CFF", eyeColor: "#FAFAFA" };
export const WEBGL_COLORS = ["#7C6AF7", "#7DD3C7", "#E8B4D4"];
/** LogMem teal, matching the scoped --ob-teal tokens on the onboarding page. */
export const TEAL_LIGHT = { color: "#1F8A83", eyeColor: "#F4F4F5" };
export const TEAL_DARK = { color: "#4ECDC4", eyeColor: "#09090B" };

export function isDarkTheme() {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  const dataTheme = root.getAttribute("data-theme");
  if (dataTheme === "dark") return true;
  if (dataTheme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(theme = "auto") {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return isDarkTheme();
}

/** Calls onChange when the page theme may have changed. Returns the unsubscribe. */
export function watchTheme(onChange) {
  if (typeof document === "undefined") return () => {};
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

export function defaultVariant(dark) {
  return dark ? "white" : "black";
}

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform vec2 u_look;
uniform float u_blink;
uniform float u_mode;
uniform vec3 u_body;
uniform vec3 u_eye;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

vec3 orient(vec3 p, vec2 look) {
  float yaw = look.x * 0.92;
  float pitch = -look.y * 0.78;
  float cy = cos(yaw);
  float sy = sin(yaw);
  float cp = cos(pitch);
  float sp = sin(pitch);
  vec3 q = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
  return vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
}

float eyeMask(vec3 n, vec3 e, vec3 right, vec3 up, float halfH, float rad) {
  float facing = dot(n, e);
  float x = dot(n, right) - dot(e, right);
  float y = dot(n, up) - dot(e, up);
  y -= clamp(y, -halfH, halfH);
  float d = length(vec2(x, y)) - rad;
  float fill = 1.0 - smoothstep(-0.01, 0.01, d);
  return fill * smoothstep(0.12, 0.32, facing);
}

vec3 wash(vec3 n, float t) {
  vec2 q = n.xy * 2.2 + n.z * 0.85;
  vec2 w1 = vec2(
    fbm(q * 1.4 + vec2(t * 0.22, t * 0.18)),
    fbm(q * 1.4 + vec2(-t * 0.16, t * 0.24) + 4.1)
  );
  q += (w1 - 0.5) * 0.72;
  float f = fbm(q * 2.1 + vec2(0.0, t * 0.12));
  float g = fbm(q * 4.6 - vec2(t * 0.2, 0.0));
  vec3 col = mix(u_c1, u_c2, smoothstep(0.28, 0.72, f));
  return mix(col, u_c3, pow(smoothstep(0.42, 0.9, g), 1.4));
}

void main() {
  vec2 uv = (gl_FragCoord.xy / u_resolution.xy) * 2.0 - 1.0;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  uv.x *= aspect;

  float radius = 0.94;
  vec2 p = uv / radius;
  float r2 = dot(p, p);
  float edge = 1.0 - smoothstep(0.985, 1.012, sqrt(max(r2, 0.0)));
  if (edge <= 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(1.0 - r2, 0.0));
  vec3 n = normalize(vec3(p, z));

  vec2 look = u_look;
  float lm = length(look);
  if (lm > 1.0) look /= lm;

  vec3 right = orient(vec3(1.0, 0.0, 0.0), look);
  vec3 up = orient(vec3(0.0, 1.0, 0.0), look);
  vec3 eL = orient(normalize(vec3(-0.32, 0.08, 1.0)), look);
  vec3 eR = orient(normalize(vec3(0.32, 0.08, 1.0)), look);

  float halfH = mix(0.128, 0.012, u_blink);
  float rad = mix(0.054, 0.062, u_blink);
  float eyes = max(
    eyeMask(n, eL, right, up, halfH, rad),
    eyeMask(n, eR, right, up, halfH, rad)
  );

  vec3 body = u_mode > 0.5 ? wash(n, u_time * u_speed) : u_body;
  vec3 col = mix(body, u_eye, clamp(eyes, 0.0, 1.0));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), edge);
}
`;

export function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return [0.96, 0.96, 0.96];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function resolveVariant(variant, color, eyeColor, colors, dark = false) {
  let body = WHITE.color;
  let eye = WHITE.eyeColor;
  let mode = 0;
  let palette = WEBGL_COLORS;
  const preset = variant ?? defaultVariant(dark);

  if (preset === "black") {
    body = BLACK.color;
    eye = BLACK.eyeColor;
  } else if (preset === "webgl") {
    palette = colors && colors.length > 0 ? colors : WEBGL_COLORS;
    body = palette[1] ?? WEBGL_COLORS[1];
    eye = "#0C0C10";
    mode = 1;
  } else if (preset === "custom") {
    body = color ?? CUSTOM_DEFAULT.color;
    eye = eyeColor ?? CUSTOM_DEFAULT.eyeColor;
  }

  return { body, eye, mode, palette };
}

export function fallbackFaceStyle(resolved) {
  if (resolved.mode === 1) {
    const [a, b, c] = [0, 1, 2].map((i) => resolved.palette[i] ?? WEBGL_COLORS[i]);
    return { backgroundImage: `linear-gradient(135deg, ${a}, ${b}, ${c})` };
  }
  return { backgroundColor: resolved.body };
}

/** How long the pointer rests before the eyes start looking around. */
const IDLE_MS = 3000;
const REST_LOOK = { x: 0, y: 0.08 };

/** Draws the orb into canvas. Returns { setOptions, destroy }, or null when WebGL is missing. */
export function createLiveOrb(canvas, initial = {}) {
  let options = { interactive: true, blink: true, ...initial };
  let dark = resolveDark(options.theme);

  const look = { x: 0, y: 0.08 };
  const targetLook = { x: 0, y: 0.08 };
  const glance = { x: 0, y: 0.08 };

  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  let vs = null, fs = null, program = null, buf = null;
  let uResolution, uTime, uSpeed, uLook, uBlink, uMode, uBody, uEye, uC1, uC2, uC3;

  // Builds every GL resource. Runs at startup and again after a context restore.
  const initGl = () => {
    vs = compile(gl, gl.VERTEX_SHADER, VERT);
    fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    if (!prog) return false;
    program = prog;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);

    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    uResolution = gl.getUniformLocation(prog, "u_resolution");
    uTime = gl.getUniformLocation(prog, "u_time");
    uSpeed = gl.getUniformLocation(prog, "u_speed");
    uLook = gl.getUniformLocation(prog, "u_look");
    uBlink = gl.getUniformLocation(prog, "u_blink");
    uMode = gl.getUniformLocation(prog, "u_mode");
    uBody = gl.getUniformLocation(prog, "u_body");
    uEye = gl.getUniformLocation(prog, "u_eye");
    uC1 = gl.getUniformLocation(prog, "u_c1");
    uC2 = gl.getUniformLocation(prog, "u_c2");
    uC3 = gl.getUniformLocation(prog, "u_c3");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
  };

  if (!initGl()) return null;
  if (options.onHasGl) options.onHasGl(true);

  let raf = 0;
  let destroyed = false;
  let lost = false; // set while the GPU context is gone
  let onScreen = true;
  let last = 0;
  let clock = 0; // ms of motion so far
  let nextBlink = 1800 + Math.random() * 2400;
  let blinkAt = -10000;
  let nextGlance = 600 + Math.random() * 900;
  let pointerAt = -Infinity;

  /** Returns whether the backing size changed, which clears the canvas. */
  const resize = () => {
    const parent = canvas.parentElement;
    if (!parent) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w <= 0 || h <= 0) return false;
    const width = Math.max(1, Math.floor(w * dpr));
    const height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (width === canvas.width && height === canvas.height) return false;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
  };

  const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const moving = () => onScreen && !mqReduce.matches && document.visibilityState !== "hidden";

  function wake() {
    if (raf || destroyed || lost) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  // Resizing clears the canvas, so draw at once with zero dt.
  function redraw() {
    if (destroyed || lost) return;
    cancelAnimationFrame(raf);
    raf = 0;
    last = performance.now();
    tick(last);
  }

  const onMove = (e) => {
    if (!options.interactive) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
    const dy = (rect.top + rect.height / 2 - e.clientY) / (rect.height / 2);
    targetLook.x = Math.min(1, Math.max(-1, dx));
    targetLook.y = Math.min(1, Math.max(-1, dy));
    pointerAt = performance.now();
    if (onScreen) wake();
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  const tick = (now) => {
    raf = 0;
    if (lost) return;
    const dt = Math.min(50, Math.max(0, now - last));
    last = now;
    const live = moving();
    if (live) clock += dt;
    const reduce = mqReduce.matches;

    const resolved = resolveVariant(options.variant, options.color, options.eyeColor, options.colors, dark);
    const time = clock / 1000;

    // The pointer steers until it rests. Then the eyes look around.
    const steering = options.interactive && now - pointerAt < IDLE_MS;
    if (!steering && live && clock >= nextGlance) {
      const back = Math.random() < 0.3;
      glance.x = back ? 0 : (Math.random() * 2 - 1) * 0.8;
      glance.y = back ? 0.08 : (Math.random() * 2 - 1) * 0.5;
      nextGlance = clock + 900 + Math.random() * 2100;
    }
    const goal = steering ? targetLook : reduce ? REST_LOOK : glance;
    const ease = live ? (steering ? 0.16 : 0.1) : 1;
    look.x += (goal.x - look.x) * ease;
    look.y += (goal.y - look.y) * ease;

    if (!reduce && options.blink && clock >= nextBlink) {
      blinkAt = clock;
      nextBlink = clock + 2200 + Math.random() * 3800;
    }
    const bt = (clock - blinkAt) / 1000;
    let b = 0;
    if (!reduce && options.blink) {
      if (bt < 0.055) b = bt / 0.055;
      else if (bt < 0.1) b = 1;
      else if (bt < 0.18) b = 1 - (bt - 0.1) / 0.08;
    }
    const body = hexToRgb(resolved.body);
    const eye = hexToRgb(resolved.eye);
    const palette = [0, 1, 2].map((i) => hexToRgb(resolved.palette[i % resolved.palette.length] ?? WEBGL_COLORS[i]));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, reduce ? 0 : time);
    gl.uniform1f(uSpeed, reduce ? 0 : 0.55);
    gl.uniform2f(uLook, look.x, look.y);
    gl.uniform1f(uBlink, b);
    gl.uniform1f(uMode, resolved.mode);
    gl.uniform3f(uBody, body[0], body[1], body[2]);
    gl.uniform3f(uEye, eye[0], eye[1], eye[2]);
    gl.uniform3f(uC1, palette[0][0], palette[0][1], palette[0][2]);
    gl.uniform3f(uC2, palette[1][0], palette[1][1], palette[1][2]);
    gl.uniform3f(uC3, palette[2][0], palette[2][1], palette[2][2]);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (live && !destroyed) raf = requestAnimationFrame(tick);
  };

  const ro = new ResizeObserver(() => {
    if (resize()) redraw();
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  const io = new IntersectionObserver(([entry]) => {
    onScreen = entry ? entry.isIntersecting : true;
    wake();
  });
  io.observe(canvas);
  const onVisibility = () => wake();
  document.addEventListener("visibilitychange", onVisibility);
  const onReduce = () => wake();
  mqReduce.addEventListener("change", onReduce);
  const syncTheme = () => {
    const next = resolveDark(options.theme);
    if (next === dark) return;
    dark = next;
    wake();
  };
  const unwatchTheme = watchTheme(syncTheme);

  // Without preventDefault the browser never hands the context back.
  const onLost = (e) => {
    e.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
    canvas.style.visibility = "hidden"; // a lost canvas paints a broken-image icon
    if (options.onHasGl) options.onHasGl(false);
  };
  const onRestored = () => {
    if (destroyed) return;
    if (!initGl()) return; // a failed rebuild leaves the CSS fallback showing
    lost = false;
    canvas.style.visibility = "";
    if (options.onHasGl) options.onHasGl(true);
    wake();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  resize();
  wake();

  return {
    setOptions(next) {
      options = { ...options, ...next };
      dark = resolveDark(options.theme);
      wake();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mqReduce.removeEventListener("change", onReduce);
      unwatchTheme();
      window.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (lost) canvas.style.visibility = "";
      if (options.onHasGl) options.onHasGl(false);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      // Free the GPU context once the canvas has left the page. Browsers cap live contexts.
      const lose = gl.getExtension("WEBGL_lose_context");
      queueMicrotask(() => {
        if (!canvas.isConnected && !gl.isContextLost() && lose) lose.loseContext();
      });
    },
  };
}

function eyeSpan(host, color, left) {
  const s = document.createElement("span");
  s.style.cssText = `position:absolute;border-radius:999px;width:13%;height:28%;top:34%;left:${left}%;background:${color}`;
  host.appendChild(s);
  return s;
}

/**
 * Puts an orb in host. The host needs a size, for example 96px by 96px.
 * Without WebGL the host keeps a flat CSS face. Returns { destroy }.
 * opts: { variant, color, eyeColor, colors, interactive, blink, theme }.
 * With no variant, the orb uses LogMem teal and follows the page theme.
 */
export function mount(host, opts = {}) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;width:100%;height:100%";
  wrap.setAttribute("aria-hidden", "true");
  const face = document.createElement("div");
  face.style.cssText = "position:absolute;inset:2%;overflow:hidden;border-radius:50%";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  wrap.append(face, canvas);
  host.appendChild(wrap);

  const pick = () => {
    if (opts.variant) return opts;
    const t = resolveDark(opts.theme) ? TEAL_DARK : TEAL_LIGHT;
    return { ...opts, variant: "custom", color: t.color, eyeColor: t.eyeColor };
  };
  const paintFace = () => {
    const p = pick();
    const r = resolveVariant(p.variant, p.color, p.eyeColor, p.colors, resolveDark(opts.theme));
    face.replaceChildren();
    Object.assign(face.style, { backgroundColor: "", backgroundImage: "" }, fallbackFaceStyle(r));
    eyeSpan(face, r.eye, 31);
    eyeSpan(face, r.eye, 56);
  };
  const setGl = (ok) => {
    face.style.display = ok ? "none" : "";
  };
  paintFace();

  const orb = createLiveOrb(canvas, { ...pick(), theme: opts.theme, onHasGl: setGl });
  const sync = () => {
    paintFace();
    if (orb) orb.setOptions({ ...pick(), theme: opts.theme });
  };
  const unwatch = watchTheme(sync);
  return {
    destroy() {
      unwatch();
      if (orb) orb.destroy();
      wrap.remove();
    },
  };
}
