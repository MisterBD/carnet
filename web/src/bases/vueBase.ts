// Carnet · bases : vue de nœud (NodeView Tiptap) d'un bloc de code ```base.
// Le texte YAML reste le contenu du bloc (c'est lui qui est enregistré dans le .md) ; par-dessus, un tableau vivant
// (React). « Voir le YAML » montre le code, modifiable comme tout bloc de code. Le tableau ne modifie le bloc que
// par `remplacerSource` (tri, filtres), une transaction de l'éditeur : annulable, enregistrée comme le reste.
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ContexteEditeur } from "../editeur/contexte";
import { lowlightCarnet } from "../editeur/langues";
import { TableauBase } from "./TableauBase";

// Le YAML d'une base est coloré comme du YAML.
try { lowlightCarnet.registerAlias({ yaml: ["base"] }); } catch { /* déjà fait */ }

export function estBlocBase(n: PMNode): boolean {
  return n.type.name === "codeBlock" && n.attrs.language === "base";
}

export function vueBase(contexte: ContexteEditeur) {
  return (p: NodeViewRendererProps) => {
    let node = p.node;
    const { editor } = p;
    const dom = document.createElement("div");
    dom.className = "carnet-base";
    const hote = document.createElement("div");
    hote.className = "carnet-base__vue";
    hote.contentEditable = "false";
    // le YAML garde l'habillage et la coloration des blocs de code de l'éditeur
    const cadreYaml = document.createElement("div");
    cadreYaml.className = "carnet-code carnet-base__yaml";
    const pre = document.createElement("pre");
    pre.className = "carnet-code__pre";
    pre.spellcheck = false;
    const code = document.createElement("code");
    pre.append(code);
    cadreYaml.append(pre);
    dom.append(hote, cadreYaml);
    const cree = Date.now();
    let yaml = false;
    let detruit = false;
    const racine = createRoot(hote);

    const posDe = (): number | null => {
      const r = typeof p.getPos === "function" ? p.getPos() : undefined;
      return typeof r === "number" ? r : null;
    };

    const remplacerSource = (s: string) => {
      const pos = posDe();
      if (pos == null || detruit || !editor.isEditable) return;
      const de = pos + 1;
      const a = pos + 1 + node.content.size;
      const tr = s ? editor.state.tr.replaceWith(de, a, editor.schema.text(s)) : editor.state.tr.delete(de, a);
      editor.view.dispatch(tr);
    };

    const basculerYaml = () => {
      yaml = !yaml;
      rendre();
      if (yaml && editor.isEditable) {
        const pos = posDe();
        if (pos != null) editor.chain().focus().setTextSelection(pos + 1 + node.content.size).run();
      }
    };

    function rendre() {
      if (detruit) return;
      dom.dataset.yaml = yaml ? "true" : "false";
      racine.render(createElement(TableauBase, {
        chemin: contexte.chemin,
        source: node.textContent,
        modifiable: editor.isEditable,
        remplacerSource,
        yamlVisible: yaml,
        basculerYaml,
        notifier: (m: string) => contexte.notifier(m),
      }));
    }
    rendre();

    // Le curseur entre dans le YAML (flèches, clic) : on le montre.
    const surSelection = () => {
      // juste après l'insertion (menu « / »), le curseur est dans le bloc : on garde le tableau
      if (yaml || !editor.isFocused || Date.now() - cree < 800) return;
      const pos = posDe();
      if (pos == null) return;
      const { from, to } = editor.state.selection;
      if (from > pos && to < pos + node.nodeSize) { yaml = true; rendre(); }
    };
    editor.on("selectionUpdate", surSelection);

    return {
      dom,
      contentDOM: code,
      update: (n: PMNode) => {
        if (n.type !== node.type || !estBlocBase(n)) return false;
        const change = n.textContent !== node.textContent;
        node = n;
        if (change) rendre();
        return true;
      },
      stopEvent: (e: Event) => hote.contains(e.target as Node),
      ignoreMutation: (m: { type: string; target: Node }) => m.type !== "selection" && (hote.contains(m.target) || m.target === dom),
      destroy: () => {
        detruit = true;
        editor.off("selectionUpdate", surSelection);
        queueMicrotask(() => racine.unmount());
      },
    };
  };
}
