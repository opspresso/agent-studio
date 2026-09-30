"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@mantine/hooks";
import { IconArrowsMaximize, IconArrowsMinimize, IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import { useT } from "../../_i18n/provider";
import classes from "../../page.module.css";

/** Deterministic particle distribution keeps the artwork stable across resizes. */
function noise(index: number) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function ParticleField() {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef({ phase: 0, expansion: 0 });
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const reducedMotion = useReducedMotion(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    let lastTime = 0;
    let visible = false;
    const pointer = { x: 0, y: 0, active: false };
    // Bound drawing work per frame and reduce the count on narrow screens.
    const count = window.matchMedia("(max-width: 600px)").matches ? 2400 : 6200;
    const particles = Array.from({ length: count }, (_, index) => {
      const u = index / count * Math.PI * 2;
      const v = noise(index + 830) * Math.PI * 2;
      const tube = 0.21 + noise(index + 140) * 0.045;
      const radius = 0.73 + tube * Math.cos(v);
      return {
        x: radius * Math.cos(u), y: radius * Math.sin(u), z: tube * Math.sin(v),
        size: 0.6 + noise(index + 900) * 1.1,
        bright: noise(index + 70),
        scatterX: (noise(index + 200) - 0.5) * 3,
        scatterY: (noise(index + 300) - 0.5) * 3,
      };
    });

    function draw(delta = 0) {
      if (!canvas || !context || !width || !height) return;
      scene.current.phase += delta * 0.00012;
      const target = expanded ? 1 : 0;
      scene.current.expansion = reducedMotion || paused
        ? target
        : scene.current.expansion + (target - scene.current.expansion) * Math.min(1, delta * 0.003);
      const { phase, expansion } = scene.current;
      context.clearRect(0, 0, width, height);
      const radius = Math.min(width, height) * 0.42;
      const tilt = 0.62 + Math.sin(phase * 0.7) * 0.16;
      const spin = phase * 0.4 - 0.42;
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);
      const cosSpin = Math.cos(spin);
      const sinSpin = Math.sin(spin);

      for (const point of particles) {
        const x = point.x * cosSpin - point.y * sinSpin;
        const y = point.x * sinSpin + point.y * cosSpin;
        const depth = y * sinTilt + point.z * cosTilt;
        const perspective = 2.8 / (2.8 - depth);
        let px = x * radius * perspective;
        let py = (y * cosTilt - point.z * sinTilt) * radius * perspective;
        // Rotate the projected ring into a diagonal orbit.
        const rx = px * 0.87 - py * 0.49;
        py = px * 0.49 + py * 0.87;
        px = rx;
        px += point.scatterX * radius * expansion * 0.65;
        py += point.scatterY * radius * expansion * 0.65;
        px += width / 2;
        py += height / 2;
        if (pointer.active && !reducedMotion && !paused) {
          const dx = px - pointer.x;
          const dy = py - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 115 && distance > 0) {
            const force = (1 - distance / 115) * 26;
            px += dx / distance * force;
            py += dy / distance * force;
          }
        }
        const alpha = Math.min(1, Math.max(0.25, (depth + 1.2) * 0.6));
        context.fillStyle = point.bright > 0.86
          ? `rgba(243,255,210,${alpha})`
          : `rgba(183,235,81,${alpha * 0.85})`;
        const size = point.size * perspective;
        context.fillRect(px, py, size, size);
        if (point.bright > 0.995) {
          context.fillStyle = `rgba(218,255,156,${alpha * 0.13})`;
          context.beginPath();
          context.arc(px, py, size * 4.5, 0, Math.PI * 2);
          context.fill();
        }
      }
      // Sparse stars provide depth without a second animation loop.
      for (let index = 0; index < 65; index++) {
        const x = noise(index + 6000) * width;
        const y = noise(index + 7000) * height;
        context.fillStyle = `rgba(213,231,186,${0.1 + noise(index + 8000) * 0.22})`;
        context.fillRect(x, y, 1, 1);
      }
    }

    function tick(time: number) {
      frame = requestAnimationFrame(tick);
      if (time - lastTime < 1000 / 30) return;
      draw(lastTime ? Math.min(time - lastTime, 64) : 1000 / 30);
      lastTime = time;
    }

    function syncAnimation() {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      if (visible && !document.hidden && !paused && !reducedMotion) {
        frame = requestAnimationFrame(tick);
      } else {
        draw();
      }
    }

    const resize = new ResizeObserver(() => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      syncAnimation();
    });
    function move(event: PointerEvent) {
      if (event.pointerType === "touch") return;
      const bounds = canvas!.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
    }
    function leave() { pointer.active = false; }
    resize.observe(canvas);
    intersection.observe(canvas);
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", syncAnimation);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", syncAnimation);
    };
  }, [expanded, paused, reducedMotion]);

  return (
    <div className={classes.particleScene}>
      <div className={classes.sceneGrid} aria-hidden="true" />
      <div className={classes.sceneHalo} aria-hidden="true" />
      <canvas ref={canvasRef} className={classes.particleCanvas} aria-hidden="true" />
      <span className={`${classes.sceneTag} ${classes.sceneTagTop}`} aria-hidden="true"><i /> CONNECT</span>
      <span className={`${classes.sceneTag} ${classes.sceneTagBottom}`} aria-hidden="true"><i /> ORCHESTRATE</span>
      <div className={classes.sceneCoordinates} aria-hidden="true">AX / 01<br />COLLECTIVE INTELLIGENCE</div>
      <div className={classes.sceneControls}>
        <span>{t(reducedMotion ? "home.particles.static" : "home.hero.hint")}</span>
        <button type="button" onClick={() => setExpanded(value => !value)} aria-pressed={expanded} aria-label={t(expanded ? "home.particles.gather" : "home.particles.expand")} title={t(expanded ? "home.particles.gather" : "home.particles.expand")}>
          {expanded ? <IconArrowsMinimize size={16} /> : <IconArrowsMaximize size={16} />}
        </button>
        <button type="button" onClick={() => setPaused(value => !value)} disabled={reducedMotion} aria-pressed={paused || reducedMotion} aria-label={t(paused ? "home.particles.play" : "home.particles.pause")} title={t(paused ? "home.particles.play" : "home.particles.pause")}>
          {paused || reducedMotion ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
        </button>
      </div>
    </div>
  );
}
