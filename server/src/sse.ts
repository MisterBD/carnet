// Carnet · événements en direct (Server-Sent Events).
import type { IncomingMessage, ServerResponse } from "node:http";

const TAMPON_MAX = 1024 * 1024;

export class Diffuseur {
  #clients = new Set<ServerResponse>();
  #max: number;
  #ping: ReturnType<typeof setInterval>;

  constructor(max: number, pingMs: number) {
    this.#max = max;
    this.#ping = setInterval(() => this.#ecrireTous(": ping\n\n"), pingMs);
    this.#ping.unref();
  }

  get nombre(): number {
    return this.#clients.size;
  }

  plein(): boolean {
    return this.#clients.size >= this.#max;
  }

  /** Ouvre le flux (les en-têtes de sécurité sont déjà posés). */
  ouvrir(req: IncomingMessage, res: ServerResponse, surFin: () => void): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    req.socket.setKeepAlive(true, 30_000);
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.write("retry: 3000\n: connecte\n\n");
    this.#clients.add(res);
    let fini = false;
    const fin = () => {
      if (fini) return;
      fini = true;
      this.#clients.delete(res);
      surFin();
    };
    res.on("close", fin);
    req.on("close", fin);
  }

  envoyer(objet: unknown): void {
    this.#ecrireTous(`data: ${JSON.stringify(objet)}\n\n`);
  }

  #ecrireTous(s: string): void {
    for (const c of this.#clients) {
      if (c.writableLength > TAMPON_MAX) { c.destroy(); continue; } // client qui ne lit plus
      c.write(s);
    }
  }

  fermer(): void {
    clearInterval(this.#ping);
    for (const c of this.#clients) c.end();
    this.#clients.clear();
  }
}
