/**
 * landing.js — the landing page (index.html): icons, the decision-loop highlight, range bars, the screenshot
 * switcher and scroll reveals. The simulator itself lives in simulator.html.
 */
import {
  createIcons,
  Activity,
  CircleCheck,
  Copy,
  Drone,
  FlaskConical,
  Layers,
  ListOrdered,
  Lock,
  Map as MapIcon,
  MessageSquareText,
  Moon,
  Play,
  Presentation,
  Server,
  TriangleAlert,
} from 'lucide';

createIcons({
  icons: { Activity, CircleCheck, Copy, Drone, FlaskConical, Layers, ListOrdered, Lock, Map: MapIcon, MessageSquareText, Moon, Play, Presentation, Server, TriangleAlert },
  attrs: { 'stroke-width': '1.75' },
});

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Navigation: a hairline once the page scrolls.
const nav = document.querySelector('[data-nav]');
const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

// Scroll reveals.
const reveals = document.querySelectorAll('.lp-reveal');
if (reduceMotion || !('IntersectionObserver' in window)) {
  for (const el of reveals) el.classList.add('is-in');
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const el of reveals) io.observe(el);
}

// Decision loop: walk the six stages while the section is on screen; hovering or focusing a stage holds it.
const loop = document.querySelector('[data-loop]');
if (loop) {
  const steps = [...loop.children];
  let idx = 0;
  let timer = null;
  const show = (i) => steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
  const start = () => {
    if (reduceMotion || timer) return;
    timer = setInterval(() => show((idx = (idx + 1) % steps.length)), 1700);
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  show(0);
  steps.forEach((s, k) => {
    s.tabIndex = 0;
    const hold = () => {
      stop();
      show((idx = k));
    };
    s.addEventListener('mouseenter', hold);
    s.addEventListener('focus', hold);
    s.addEventListener('mouseleave', start);
    s.addEventListener('blur', start);
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0.3 }).observe(loop);
  } else start();
}

// Range bars: place each bar from its data-lo / data-hi on the card's scale.
for (const card of document.querySelectorAll('[data-range]')) {
  const min = Number(card.dataset.min);
  const max = Number(card.dataset.max);
  const pct = (v) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  for (const bar of card.querySelectorAll('[data-lo]')) {
    const lo = pct(Number(bar.dataset.lo));
    const hi = pct(Number(bar.dataset.hi));
    bar.style.left = `${lo}%`;
    bar.style.width = `${Math.max(0, hi - lo)}%`;
  }
}

// Simulator screenshots.
const VIEWS = {
  advanced: {
    name: 'simulator-advanced',
    alt: 'The Advanced view: prediction, interface health, the full decision record and six live charts around the 3D twin',
    caption: 'Advanced view: live prediction, every decision with its reason, and six 60-second charts.',
  },
  mission: {
    name: 'simulator-mission',
    alt: 'The Mission view: the 3D twin with the decision loop above it and a short explanation beside it',
    caption: 'Mission view: the twin first, with the decision loop and the reason for the latest decision.',
  },
  drones: {
    name: 'drones-handover',
    alt: 'Close-up of the two drones over the night city while FlexiPath sends its critical traffic on two paths',
    caption: 'The handover burst: FlexiPath’s C2 link on Wi-Fi and 5G at once, while the legacy drone falls behind.',
  },
};
const switcher = document.querySelector('[data-views]');
const img = document.querySelector('[data-view-img]');
const caption = document.querySelector('[data-view-caption]');
if (switcher && img) {
  for (const b of switcher.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const v = VIEWS[b.dataset.view];
      img.src = `./landing/${v.name}-1200.webp`;
      img.srcset = `./landing/${v.name}-1200.webp 1200w, ./landing/${v.name}-2400.webp 2400w`;
      img.alt = v.alt;
      caption.textContent = v.caption;
      for (const o of switcher.querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
    });
  }
}
