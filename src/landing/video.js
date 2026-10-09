/**
 * video.js — the video page (video.html): just its icons. The page is static otherwise; the load-error note is
 * inline in the HTML so it works even before this module loads.
 */
import { createIcons, ChevronLeft, Play, Presentation } from 'lucide';

createIcons({ icons: { ChevronLeft, Play, Presentation }, attrs: { 'stroke-width': '1.75' } });
