// Icône d'une page : emoji du frontmatter (`icon`), ou nom d'icône Lucide (`icon: compass`, ou l'ancienne propriété `pageDecoration.icon`), sinon défaut.
import {
  FileText, Folder, Compass, Layers, SquareCheck, Users, Briefcase, ChartColumn, House, BookOpen, Calendar, Star,
  Lightbulb, Rocket, Target, Inbox, Archive, Settings, Image as IconeImage, FileArchive, File, Mic, Mail, Map,
  Newspaper, Notebook, PenLine, Sparkles, ListTodo, Wallet, Heart, Globe, Code, Database, Bot, MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { estEmoji } from "../outils";

const LUCIDE: Record<string, LucideIcon> = {
  compass: Compass, layers: Layers, "check-square": SquareCheck, "square-check": SquareCheck, users: Users,
  briefcase: Briefcase, "bar-chart-2": ChartColumn, "bar-chart": ChartColumn, "chart-column": ChartColumn,
  home: House, house: House, book: BookOpen, "book-open": BookOpen, calendar: Calendar, star: Star,
  lightbulb: Lightbulb, rocket: Rocket, target: Target, inbox: Inbox, archive: Archive, settings: Settings,
  folder: Folder, "file-text": FileText, file: File, mic: Mic, mail: Mail, map: Map, newspaper: Newspaper,
  notebook: Notebook, pen: PenLine, sparkles: Sparkles, "list-todo": ListTodo, wallet: Wallet, heart: Heart,
  globe: Globe, code: Code, database: Database, bot: Bot, "message-square": MessageSquare,
};

export function IconePage({ icone, dossier, fichier, ext, taille = 17 }: {
  icone?: string | null; dossier?: boolean; fichier?: boolean; ext?: string; taille?: number;
}) {
  if (icone && estEmoji(icone)) {
    return <span className="emoji" aria-hidden="true" style={{ fontSize: taille }}>{icone}</span>;
  }
  if (fichier) {
    const e = (ext ?? "").toLowerCase();
    const I = ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(e) ? IconeImage : e === "pdf" ? FileArchive : File;
    return <I size={taille} strokeWidth={1.8} aria-hidden="true" />;
  }
  const L = (icone && LUCIDE[icone.trim().toLowerCase()]) || (dossier ? Folder : FileText);
  return <L size={taille} strokeWidth={1.8} aria-hidden="true" />;
}

/** La vague, signature du carnet. */
export function Vague({ largeur = 22, hauteur = 10, epaisseur = 1.8, cretes = 3 }: { largeur?: number; hauteur?: number; epaisseur?: number; cretes?: number }) {
  const pas = largeur / cretes;
  let d = `M1 ${hauteur / 2}`;
  for (let i = 0; i < cretes; i++) {
    const x = 1 + i * pas;
    d += ` C ${x + pas * 0.25} ${hauteur * 0.08}, ${x + pas * 0.5} ${hauteur * 0.08}, ${x + pas * 0.5} ${hauteur / 2}`;
    d += ` S ${x + pas * 0.75} ${hauteur * 0.92}, ${x + pas} ${hauteur / 2}`;
  }
  return (
    <svg width={largeur + 2} height={hauteur} viewBox={`0 0 ${largeur + 2} ${hauteur}`} fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth={epaisseur} strokeLinecap="round" />
    </svg>
  );
}

export function Sceau() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 9.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M3 15.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity=".6" />
    </svg>
  );
}
