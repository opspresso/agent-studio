"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useComputedColorScheme, useMantineTheme } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconArrowRight, IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { Branding } from "@/shared/branding";
import { useT } from "../../_i18n/provider";
import classes from "../../page.module.css";

const STAGES = ["connect", "execute", "deliver"] as const;

function noise(index: number) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** The drawing interpolates between input streams, execution, and output streams. */
export function ParticleField({ branding }: { branding: Pick<Branding, "name" | "logoUrl"> }) {
  const t = useT();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme("light");
  const reducedMotion = useReducedMotion(false);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const animationPaused = paused || reducedMotion;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const target = useRef(0);
  const scene = useRef({ time: 0, progress: 0, redraw: () => {} });
  const stage = Math.round(progress);

  function seek(value: number) {
    target.current = value;
    setProgress(value);
    // Reduced motion and pause still allow an explicit, immediate state change.
    if (paused || reducedMotion) scene.current.redraw();
  }

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
    const blue = theme.colors[theme.primaryColor]![colorScheme === "dark" ? 4 : 6];
    const cyan = theme.colors.cyan[colorScheme === "dark" ? 4 : 6];
    const particles = Array.from({ length: 2200 }, (_, index) => ({
      offset: index / 2200,
      lane: index % 3 - 1,
      spread: noise(index + 200) - 0.5,
      size: 0.7 + noise(index + 900) * 1.3,
      bright: noise(index + 70),
    }));

    function draw(delta = 0) {
      if (!context || !width || !height) return;
      scene.current.time += delta * 0.000045;
      scene.current.progress = paused || reducedMotion
        ? target.current
        : scene.current.progress + (target.current - scene.current.progress) * Math.min(1, delta * 0.004);
      const { time, progress: position } = scene.current;
      const narrow = width <= 600;
      const length = narrow ? height : width;
      const breadth = narrow ? width : height;
      context.clearRect(0, 0, width, height);
      for (const point of particles) {
        const u = (point.offset + time) % 1;
        const strand = point.lane * 0.3;
        const jitter = point.spread * 0.12;
        const start = { x: 0.08 + u * 0.4, y: 0.5 + strand * (1 - u) ** 1.7 + jitter * Math.sin(u * Math.PI) };
        const angle = u * Math.PI * 2;
        const orbit = { x: 0.5 + Math.cos(angle) * (0.18 + point.spread * 0.06), y: 0.5 + Math.sin(angle) * (0.28 + point.lane * 0.055) };
        const end = { x: 0.52 + u * 0.4, y: 0.5 + strand * u ** 1.7 + jitter * Math.sin(u * Math.PI) };
        const from = position <= 1 ? start : orbit;
        const to = position <= 1 ? orbit : end;
        const mix = position <= 1 ? position : position - 1;
        const along = (from.x + (to.x - from.x) * mix) * length;
        const across = (from.y + (to.y - from.y) * mix) * breadth;
        let x = narrow ? across : along;
        let y = narrow ? along : across;
        if (pointer.active && !paused && !reducedMotion) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < 80) {
            const force = (1 - distance / 80) * 18;
            x += dx / distance * force;
            y += dy / distance * force;
          }
        }
        context.globalAlpha = 0.2 + point.bright * 0.6;
        context.fillStyle = point.bright > 0.65 ? cyan : blue;
        context.fillRect(x, y, point.size, point.size);
      }
      context.globalAlpha = 1;
    }

    function tick(time: number) {
      frame = requestAnimationFrame(tick);
      if (time - lastTime < 1000 / 30) return;
      draw(lastTime ? Math.min(time - lastTime, 64) : 1000 / 30);
      lastTime = time;
    }
    function syncAnimation() {
      cancelAnimationFrame(frame);
      lastTime = 0;
      if (visible && !document.hidden && !paused && !reducedMotion) frame = requestAnimationFrame(tick);
      else draw();
    }
    scene.current.redraw = () => draw();
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
      scene.current.redraw = () => {};
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", syncAnimation);
    };
  }, [paused, reducedMotion, colorScheme, theme]);

  return <div className={classes.flowWorkbench} data-stage={stage}>
    <div className={classes.flowHeading}><span>{t("home.flow.eyebrow")}</span><span>{t("home.cases.example")}</span></div>
    <div className={classes.flowScene}>
      <svg className={classes.flowGuides} viewBox="0 0 1000 360" preserveAspectRatio="none" aria-hidden="true">
        <path d="M80 72C300 72 300 180 500 180S700 72 920 72M80 180H920M80 288C300 288 300 180 500 180S700 288 920 288" />
      </svg>
      <canvas ref={canvasRef} className={classes.particleCanvas} aria-hidden="true" />
      <div className={`${classes.flowNodes} ${classes.flowInputs}`}>
        <span>Web Chat</span><span>Slack · Teams · Telegram</span><span>API · Webhook</span>
      </div>
      <div className={classes.flowIdentity}><Image src={branding.logoUrl} alt="" width={56} height={56} /><strong>{branding.name}</strong><span>{t(`home.flow.${STAGES[stage]!}`)}</span></div>
      <div className={`${classes.flowNodes} ${classes.flowOutputs}`}>
        <span>{t(stage === 2 ? "home.flow.documentOutput" : "home.flow.models")}</span>
        <span>{stage === 2 ? t("home.flow.audioOutput") : "Skills · MCP"}</span>
        <span>{t(stage === 2 ? "home.flow.codeOutput" : "home.flow.results")}</span>
      </div>
    </div>
    <div className={classes.flowControls}>
      <div className={classes.flowSteps} role="group" aria-label={t("home.flow.control")}>
        {STAGES.map((key, index) => <button type="button" key={key} aria-pressed={stage === index} onClick={() => seek(index)}><span>0{index + 1}</span>{t(`home.flow.${key}`)}{index < 2 && <IconArrowRight size={16} aria-hidden="true" />}</button>)}
      </div>
      <input type="range" min={0} max={2} step={0.01} value={progress} onChange={event => seek(Number(event.currentTarget.value))} aria-label={t("home.flow.control")} aria-valuetext={t(`home.flow.${STAGES[stage]!}`)} />
      <button className={classes.motionButton} type="button" onClick={() => setPaused(value => !value)} disabled={reducedMotion} aria-label={t(animationPaused ? "home.particles.play" : "home.particles.pause")}>
        {animationPaused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
      </button>
    </div>
    <div className={classes.flowCaption}><p aria-live="polite">{t(`home.flow.${STAGES[stage]!}Body`)}</p><span>{t(reducedMotion ? "home.particles.static" : "home.flow.hint")}</span></div>
  </div>;
}
