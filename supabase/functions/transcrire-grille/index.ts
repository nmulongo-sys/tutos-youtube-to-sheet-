// Fonction Edge « transcrire-grille » — projet Supabase « Music Noel ».
// Reçoit une photo de grille de tuto de cajón, renvoie la ou les lignes rythmiques.
//
// Pourquoi côté serveur : la clé Gemini est fournie par Jean et ne doit jamais
// atteindre le navigateur. L'app appelle cette fonction avec la clé anon qu'elle
// embarque déjà (verify_jwt reste actif), et n'a donc aucune clé à configurer.
//
// Deux modèles sont interrogés en parallèle. Le banc d'essai du 19/07/2026 a montré
// que leur SEUL mode d'échec est la confusion S/s (claqué contre fantôme) et qu'ils
// se trompent sur des cases différentes : leur désaccord désigne donc précisément
// les cases à vérifier à l'écran. Aucun décalage de colonne observé sur 3 modèles
// × 12 grilles — le mode d'échec redouté n'existe pas en pratique.
//
// Secret à définir dans le tableau de bord Supabase : GEMINI_API_KEY
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODELE_PRINCIPAL = "gemini-3.5-flash";
const MODELE_SECOND = "gemini-3.1-flash-lite";
const MAX_PAR_IP_PAR_JOUR = 40;
const MAX_OCTETS_B64 = 8_000_000; // ~6 Mo d'image ; l'app réduit déjà avant d'envoyer
const MIMES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];

const PROMPT = `Tu lis une capture d'écran ou une photo d'un tutoriel de cajón. Elle contient une grille rythmique : des cases représentant des doubles-croches, 16 par mesure, groupées par temps de 4 (comptées « 1 e & a 2 e & a … »). Chaque case peut contenir une lettre de frappe et, souvent, une main.

Frappes :
- B = basse (bass), frappe grave
- S = slap / claqué, en MAJUSCULE
- s = ghost / frappe fantôme, en minuscule — souvent écrite plus petite, plus pâle ou entre parenthèses
- case vide = silence

Mains : R ou D = main droite · L ou G = main gauche.

L'image peut contenir PLUSIEURS grilles (une page d'exercices en présente souvent deux ou trois). Transcris-les TOUTES, dans l'ordre où elles apparaissent, de haut en bas. Ne transcris que les grilles entièrement visibles : si une grille est coupée par le bord de l'image, ignore-la.

Réponds uniquement par les grilles, sans aucun autre texte, sans balisage. Chaque grille occupe exactement deux lignes :
Ligne 1 — les frappes : un caractère par double-croche (B, S, s ou « . » pour un silence), groupés par 4 avec une espace entre les temps.
Ligne 2 — les mains : R ou L par frappe (« . » si aucune main n'est indiquée à cette position), même longueur et même groupement que la ligne 1. Si l'image n'indique aucune main, rends une ligne entière de « . ».

Sépare deux grilles par une ligne vide. La longueur de chaque ligne doit être un multiple de 16 caractères (hors espaces).

Attention particulière à la distinction entre S majuscule (claqué) et s minuscule (fantôme) : c'est la seule chose que l'on se trompe habituellement. Le fantôme est écrit plus petit et dans une couleur plus discrète. Lis les colonnes avec soin : chaque lettre doit rester exactement dans sa colonne.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Grille = { frappes: string; mains: string | null };

/* ---------- analyseur : même logique que le banc d'essai (auto-testé 15/15) ---------- */
function normFrappes(ligne: string): [string, number] {
  const s = ligne.replace(/[\s|,;_]/g, "");
  let out = "", inconnus = 0;
  for (const ch of s) {
    if ("BSs.".includes(ch)) out += ch;
    else if (ch === "b") out += "B";
    else if ("·–—-o0".includes(ch)) out += ".";
    else { out += "?"; inconnus++; }
  }
  return [out, inconnus];
}

function normMains(ligne: string): [string, number] {
  const s = ligne.replace(/[\s|,;_]/g, "").toUpperCase();
  let out = "", inconnus = 0;
  for (const ch of s) {
    if ("RL".includes(ch)) out += ch;
    else if (ch === "D") out += "R";
    else if (ch === "G") out += "L";
    else if (".·–—-O0".includes(ch)) out += ".";
    else { out += "?"; inconnus++; }
  }
  return [out, inconnus];
}

/** Appariement glouton : ne dépend pas des lignes vides, un modèle n'en met pas toujours. */
function extraireGrilles(texte: string): Grille[] {
  const lignes = texte.replace(/```/g, "\n").split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  const grilles: Grille[] = [];
  for (let i = 0; i < lignes.length; i++) {
    const [nf, inc] = normFrappes(lignes[i]);
    if (nf.length >= 16 && nf.length % 16 === 0 && inc === 0 && /[BSs]/.test(nf)) {
      let mains: string | null = null;
      if (i + 1 < lignes.length) {
        const [nm, incm] = normMains(lignes[i + 1]);
        if (incm === 0 && nm.length === nf.length) { mains = nm; i++; }
      }
      grilles.push({ frappes: nf, mains });
    }
  }
  return grilles;
}

/* ---------- appel Gemini ----------
   Le free tier plafonne à 10 requêtes par minute et par modèle : sans reprise,
   deux utilisateurs simultanés suffisent à provoquer un échec. On reprend donc
   sur 429/500/503, et le message d'erreur porte la cause exacte (jamais la clé :
   on ne renvoie que le corps de la réponse, pas l'URL qui la contient). */
async function transcrire(modele: string, image: string, mime: string, cle: string): Promise<Grille[]> {
  const attentes = [1500, 4000];
  let derniere = "cause inconnue";
  for (let essai = 0; essai <= attentes.length; essai++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${cle}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (r.ok) {
      const rep = await r.json();
      const cand = rep?.candidates?.[0];
      const texte = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      if (!texte) {
        // réponse vide : filtre de sécurité, ou génération interrompue
        const cause = rep?.promptFeedback?.blockReason ?? cand?.finishReason ?? "réponse vide";
        throw new Error(`${modele} : ${cause}`);
      }
      return extraireGrilles(texte);
    }
    derniere = `HTTP ${r.status} ${(await r.text()).slice(0, 200).replace(/\s+/g, " ")}`;
    if (![429, 500, 503].includes(r.status)) break;
    if (essai < attentes.length) await new Promise((res) => setTimeout(res, attentes[essai]));
  }
  throw new Error(`${modele} : ${derniere}`);
}

/* ---------- le désaccord entre les deux modèles désigne les cases à vérifier ---------- */
function comparer(principal: Grille[], second: Grille[]) {
  return principal.map((g, i) => {
    const autre = second[i];
    if (!autre) return { ...g, doute: [] as number[], corroboree: false };
    const n = Math.min(g.frappes.length, autre.frappes.length);
    const doute: number[] = [];
    for (let k = 0; k < n; k++) if (g.frappes[k] !== autre.frappes[k]) doute.push(k);
    // longueurs différentes : tout ce qui dépasse est incertain par construction
    for (let k = n; k < g.frappes.length; k++) doute.push(k);
    return { ...g, doute, corroboree: true };
  });
}

const json = (corps: unknown, statut = 200) =>
  new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erreur: "Méthode non autorisée." }, 405);

  const cle = Deno.env.get("GEMINI_API_KEY");
  if (!cle) {
    return json({ ok: false, erreur: "Le service de lecture de photo n'est pas encore configuré." }, 503);
  }

  let image: string, mime: string;
  try {
    const corps = await req.json();
    image = String(corps.image ?? "");
    mime = String(corps.mime ?? "image/jpeg").toLowerCase();
  } catch {
    return json({ ok: false, erreur: "Requête illisible." }, 400);
  }
  if (!image) return json({ ok: false, erreur: "Aucune image reçue." }, 400);
  if (!MIMES.includes(mime)) return json({ ok: false, erreur: `Format d'image non géré (${mime}).` }, 415);
  if (image.length > MAX_OCTETS_B64) {
    return json({ ok: false, erreur: "Image trop lourde — réduisez-la avant l'envoi." }, 413);
  }

  // plafond par IP : la clé étant côté serveur, sans cela un seul visiteur
  // peut vider le quota gratuit du jour et éteindre la fonction pour tout le monde
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  let utilise = 0;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/incr_quota_vision`, {
      method: "POST",
      headers: {
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_ip: ip, p_max: MAX_PAR_IP_PAR_JOUR }),
    });
    if (r.ok) utilise = Number(await r.json()) || 0;
  } catch { /* le compteur ne doit jamais bloquer le service s'il tombe */ }
  if (utilise > MAX_PAR_IP_PAR_JOUR) {
    return json({
      ok: false,
      erreur: `Limite de ${MAX_PAR_IP_PAR_JOUR} photos par jour atteinte. Revenez demain, ou saisissez la grille à la main.`,
    }, 429);
  }

  // le second modèle ne sert qu'à désigner les cases douteuses — mais si le principal
  // tombe, il prend le relais : 98 % de justesse au banc, très préférable à un échec
  const [rPrincipal, rSecond] = await Promise.allSettled([
    transcrire(MODELE_PRINCIPAL, image, mime, cle),
    transcrire(MODELE_SECOND, image, mime, cle),
  ]);
  const lu = (r: PromiseSettledResult<Grille[]>) =>
    r.status === "fulfilled" && r.value.length ? r.value : null;
  const echec = (r: PromiseSettledResult<Grille[]>) =>
    r.status === "rejected" ? String(r.reason?.message ?? r.reason) : null;

  let grilles = lu(rPrincipal), retenu = MODELE_PRINCIPAL, second = lu(rSecond) ?? [];
  if (!grilles) {
    if (!second.length) {
      const causes = [echec(rPrincipal), echec(rSecond)].filter(Boolean);
      console.error("les deux modèles ont échoué :", causes.join(" | "));
      const cadence = causes.some((c) => c!.includes("429"));
      return json({
        ok: false,
        erreur: cadence
          ? "Trop de demandes en ce moment. Réessayez dans une minute."
          : "Aucune grille reconnue sur cette photo. Cadrez la grille de plus près, en évitant les reflets.",
        detail: causes.join(" | ").slice(0, 300),
      }, cadence ? 429 : 422);
    }
    grilles = second;      // repli sur le second modèle
    retenu = MODELE_SECOND;
    second = [];           // plus de second avis : pas de surlignage à proposer
  }

  return json({
    ok: true,
    grilles: comparer(grilles, second),
    modeles: { principal: retenu, second: second.length ? MODELE_SECOND : null },
    quota: { utilise, max: MAX_PAR_IP_PAR_JOUR },
  });
});
