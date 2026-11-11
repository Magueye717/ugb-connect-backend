import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import { errors } from '../../platform/http/errors.js';
import { LATE_CANCEL_FEE, PUBLICATION_FEE } from '../events/index.js';

/**
 * The terms of use and the privacy policy, served to the app (welcome screen, sign-up, profile): changed here, without
 * an app update. `TERMS_VERSION` is what a student accepts at sign-up (recorded on the account): bump it, and the date,
 * whenever the terms change in substance.
 */
export const TERMS_VERSION = '2026-11';
const UPDATED_AT = '2026-11-11';

export const LEGAL_DOCS = ['conditions', 'confidentialite'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

type Section = { title: string; paragraphs: string[] };
type Contacts = { phone: string; email: string };

const pct = (x: number) => `${Math.round(x * 100)} %`;

function conditions(c: Contacts): Section[] {
  return [
    {
      title: 'Objet',
      paragraphs: [
        'UGB Connect est une application destinée aux étudiants de l’Université Gaston Berger de Saint-Louis et aux commerces, organisateurs et équipes qui travaillent avec eux. Elle regroupe : les menus des restaurants universitaires, la commande auprès des restaurants et boutiques du campus, la réservation de places dans les caravanes, le partage de taxis (Sunu Taxi), la billetterie des événements, les objets perdus et trouvés, les lieux du campus et les annonces.',
        'En créant un compte, tu acceptes les présentes conditions. Si tu ne les acceptes pas, n’utilise pas l’application.',
      ],
    },
    {
      title: 'Ton compte',
      paragraphs: [
        'Le compte étudiant est réservé aux étudiants de l’UGB. Tu t’inscris avec ton numéro de téléphone (vérifié par un code) et ton numéro étudiant, que tu certifies être le tien. Un seul compte par personne.',
        'Tu es responsable de ton mot de passe et de ce qui est fait depuis ton compte. Si tu penses qu’il est utilisé par quelqu’un d’autre, change ton mot de passe et préviens-nous.',
        'Ton UFR, ta région et les informations de ta carte étudiant se modifient une fois par an, à la rentrée. Les informations que tu donnes doivent être exactes.',
      ],
    },
    {
      title: 'Paiements',
      paragraphs: [
        'Les paiements se font par Wave ou Orange Money, ou en espèces lorsque le commerce l’accepte. UGB Connect ne conserve jamais tes codes ni l’accès à ton compte Wave ou Orange Money : le paiement est validé chez l’opérateur.',
        'Les prix sont affichés en francs CFA, toutes taxes comprises. Le prix d’une caravane, d’un billet ou d’un article est celui affiché au moment de la commande.',
      ],
    },
    {
      title: 'Annulations et remboursements',
      paragraphs: [
        `Caravanes et événements : l’annulation est gratuite jusqu’à 24 h avant le départ ou le début ; ensuite, des frais de ${pct(LATE_CANCEL_FEE)} sont retenus. Si le départ n’atteint pas son nombre minimum de passagers, ou si l’organisateur annule, tout le monde est remboursé intégralement.`,
        'Commandes : une commande refusée par le commerce, ou annulée par toi avant qu’il l’accepte, est remboursée sur ton numéro de paiement. Une commande payée en espèces n’est réglée qu’à la remise.',
        'Sunu Taxi : ta participation devient non remboursable peu avant le départ, au moment choisi par l’organisateur du trajet et affiché avant que tu rejoignes.',
        'Les remboursements sont versés sur le numéro Wave ou Orange Money utilisé pour payer.',
      ],
    },
    {
      title: 'Commerces, organisateurs et événements',
      paragraphs: [
        'Les restaurants, boutiques, organisateurs de caravanes et d’événements sont seuls responsables de leurs produits, de leurs trajets et de leurs événements (qualité, horaires, sécurité, respect des lois). UGB Connect met en relation et encaisse pour leur compte, puis leur reverse les sommes dues.',
        `Un étudiant qui publie son propre événement le soumet à la validation de l’équipe. Une fois validé, il paie la publication (${PUBLICATION_FEE.perPlace} FCFA par place mise en vente, ${PUBLICATION_FEE.minimum} FCFA au minimum). Ces frais ne sont pas remboursés si l’organisateur annule l’événement ; les billets vendus, eux, sont remboursés aux acheteurs.`,
      ],
    },
    {
      title: 'Ce que tu publies',
      paragraphs: [
        'Annonces, objets perdus, messages, avis, photos : tu publies sous ta responsabilité. Sont interdits les contenus faux, insultants, discriminatoires, à caractère sexuel, les arnaques et tout ce qui porte atteinte à la vie privée d’autrui.',
        'Les avis doivent refléter une expérience réelle. Ils sont anonymes pour les autres étudiants. Nous pouvons retirer un contenu qui ne respecte pas ces règles.',
      ],
    },
    {
      title: 'Objets perdus',
      paragraphs: [
        'Quand tu signales un objet trouvé, sa photo et sa description sont visibles des autres étudiants pour que son propriétaire le reconnaisse. Remets les objets de valeur et les cartes au bureau des objets trouvés ou à leur propriétaire après vérification.',
      ],
    },
    {
      title: 'Suspension',
      paragraphs: [
        'En cas de fraude, d’usurpation d’identité, d’abus ou de non-respect de ces conditions, ton compte peut être suspendu ou fermé. Les sommes qui te sont dues restent remboursées.',
      ],
    },
    {
      title: 'Responsabilité',
      paragraphs: [
        'Nous faisons notre possible pour que l’application fonctionne en continu et que les informations (menus, horaires, annonces) soient à jour, mais elles peuvent changer sans préavis. UGB Connect n’est pas responsable des dommages résultant d’une indisponibilité du service, d’un opérateur de paiement ou du fait d’un commerce ou d’un organisateur.',
      ],
    },
    {
      title: 'Modifications et droit applicable',
      paragraphs: [
        'Ces conditions peuvent évoluer. En cas de changement important, tu en es informé dans l’application ; continuer à l’utiliser vaut acceptation de la nouvelle version.',
        'Elles sont soumises au droit sénégalais. En cas de litige, une solution amiable est recherchée en priorité, avant les tribunaux compétents de Saint-Louis.',
        `Contact : ${c.email} · ${c.phone}.`,
      ],
    },
  ];
}

function confidentialite(c: Contacts): Section[] {
  return [
    {
      title: 'En bref',
      paragraphs: [
        'Nous collectons seulement ce qu’il faut pour faire fonctionner l’application. Nous ne vendons jamais tes données. Tu peux les consulter, les corriger ou demander leur suppression à tout moment.',
        'Ces traitements respectent la loi sénégalaise n° 2008-12 du 25 janvier 2008 sur la protection des données à caractère personnel.',
      ],
    },
    {
      title: 'Ce que nous collectons',
      paragraphs: [
        'Ton compte : prénom, nom, numéro de téléphone, numéro étudiant, campus, village et chambre si tu les indiques, UFR, région d’origine, photo de profil.',
        'Ta carte étudiant, si tu choisis de la scanner : date et lieu de naissance, nationalité. La photo de la carte sert uniquement à la lecture et n’est jamais conservée.',
        'Ton activité : réservations, billets, commandes, trajets Sunu Taxi, objets déclarés, messages échangés dans l’application, avis.',
        'Les paiements : les achats auprès des restaurants, boutiques et organisateurs se règlent en espèces, en main propre ; l’application enregistre seulement le montant et sa validation. Les frais payés à UGB Connect (publication d’un événement, bannières) passent par Wave ou Orange Money : nous gardons le montant, l’opérateur et la référence de la transaction, jamais ton code ni l’accès à ton compte de paiement.',
        'Ton appareil : un identifiant de notification pour t’envoyer des alertes, et ta position lorsque tu l’autorises (carte du campus, adresse de livraison).',
      ],
    },
    {
      title: 'Pourquoi',
      paragraphs: [
        'Pour te fournir le service : vérifier ton compte, traiter tes réservations, commandes et paiements, te rembourser, t’envoyer tes billets et tes alertes.',
        'Pour t’envoyer les annonces qui te concernent (ton UFR, ton campus, ta région) et, si tu l’acceptes, les notifications que tu choisis dans tes préférences.',
        'Pour la sécurité : prévenir la fraude, l’usurpation d’identité et les abus.',
      ],
    },
    {
      title: 'Qui y a accès',
      paragraphs: [
        'Le commerce ou l’organisateur concerné voit ce qu’il faut pour te servir : ton prénom, ton nom, ton numéro pour une livraison ou un départ, ta commande ou ton billet.',
        'Les autres étudiants voient ce que tu publies (objets perdus, trajets Sunu Taxi). Tes avis sont anonymes pour eux.',
        'Les opérateurs de paiement (Wave, Orange Money) et nos prestataires techniques (hébergement, envoi de SMS et de notifications) traitent les données nécessaires à leur service, pour notre compte uniquement.',
        'L’équipe UGB Connect, selon son rôle (support, finances, validation des contenus). Les autorités, uniquement si la loi l’exige.',
      ],
    },
    {
      title: 'Combien de temps',
      paragraphs: [
        'Tes données sont conservées tant que ton compte est actif. Les informations de paiement et de remboursement sont gardées le temps exigé par la loi. Après la fermeture de ton compte, le reste est supprimé ou rendu anonyme.',
      ],
    },
    {
      title: 'Tes droits',
      paragraphs: [
        'Tu peux accéder à tes données, les rectifier, t’opposer à certains traitements et demander leur suppression. Une grande partie se modifie directement dans ton profil ; pour le reste, écris-nous.',
        'Tu peux aussi saisir la Commission de Protection des Données Personnelles (CDP) du Sénégal.',
      ],
    },
    {
      title: 'Supprimer ton compte',
      paragraphs: [
        `Écris-nous depuis le numéro de ton compte, par WhatsApp ou SMS au ${c.phone}, ou par e-mail à ${c.email}, en indiquant « Supprimer mon compte ». Nous confirmons la demande, puis le compte est fermé sous 30 jours.`,
        'Sont supprimés : ton profil, ta photo, ta carte étudiant, tes messages, tes trajets et tes annonces. Sont gardés le temps exigé par la loi, puis supprimés : les traces de paiement et de remboursement. Tes avis restent, anonymes.',
      ],
    },
    {
      title: 'Sécurité',
      paragraphs: [
        'Ton mot de passe est chiffré et n’est jamais lisible par l’équipe. Les échanges avec l’application sont chiffrés. L’accès aux données est limité aux personnes qui en ont besoin.',
      ],
    },
    {
      title: 'Contact',
      paragraphs: [`Pour toute question sur tes données : ${c.email} · ${c.phone}.`],
    },
  ];
}

const TITLES: Record<LegalDoc, string> = { conditions: 'Conditions d’utilisation', confidentialite: 'Politique de confidentialité' };

export function legalDocument(doc: LegalDoc, contacts: Contacts) {
  return { doc, title: TITLES[doc], version: TERMS_VERSION, updatedAt: UPDATED_AT, sections: doc === 'conditions' ? conditions(contacts) : confidentialite(contacts) };
}

const Doc = Type.Object({
  doc: Type.String(),
  title: Type.String(),
  version: Type.String({ description: 'What a student accepts at sign-up (POST /auth/register `termsVersion`).' }),
  updatedAt: Type.String({ description: 'YYYY-MM-DD' }),
  sections: Type.Array(Type.Object({ title: Type.String(), paragraphs: Type.Array(Type.String()) })),
});

/** Public: the welcome screen and the sign-up show them before any account exists. */
export function registerLegalRoutes(root: FastifyInstance, contacts: Contacts) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();
  app.get(
    '/reference/legal/:doc',
    { schema: { tags: ['reference'], description: 'The terms of use (`conditions`) or the privacy policy (`confidentialite`), with the current version.', params: Type.Object({ doc: Type.String() }), response: { 200: Doc } } },
    async (req) => {
      if (!(LEGAL_DOCS as readonly string[]).includes(req.params.doc)) throw errors.notFound('Document introuvable.');
      return legalDocument(req.params.doc as LegalDoc, contacts);
    },
  );
}

// ---- Public pages: the same documents in a browser (store listings, links shared outside the app) ----------------

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const frDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const slug = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A legal document as a page readable on a phone, light or dark: its sections, an index, the contacts. */
export function legalPage(doc: LegalDoc, contacts: Contacts) {
  const d = legalDocument(doc, contacts);
  const other: LegalDoc = doc === 'conditions' ? 'confidentialite' : 'conditions';
  const sections = d.sections
    .map((s) => `<section id="${slug(s.title)}"><h2>${esc(s.title)}</h2>${s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</section>`)
    .join('');
  const toc = d.sections.map((s) => `<li><a href="#${slug(s.title)}">${esc(s.title)}</a></li>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)} · UGB Connect</title>
<meta name="description" content="${esc(d.title)} de l’application UGB Connect, pour les étudiants de l’Université Gaston Berger.">
<style>
:root{--bg:#f5f7fb;--card:#fff;--text:#1f2a44;--muted:#5b6478;--line:#e3e7ef;--accent:#ff7a1a;--navy:#0a1028;--link:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141a2e;--text:#e7ebf5;--muted:#a3abc0;--line:#252d45;--navy:#e7ebf5;--link:#8aa6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.logo{width:40px;height:40px;border-radius:12px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800}
.brand{font-weight:700;color:var(--navy)}
h1{font-size:28px;line-height:1.2;margin:16px 0 4px;color:var(--navy)}
.meta{color:var(--muted);font-size:14px;margin:0 0 20px}
nav,section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:12px 0}
nav strong{display:block;margin-bottom:6px}nav ol{margin:0;padding-left:20px}nav li{margin:2px 0}
h2{font-size:19px;margin:0 0 8px;color:var(--navy)}p{margin:0 0 10px}p:last-child{margin-bottom:0}
a{color:var(--link)}footer{color:var(--muted);font-size:14px;margin-top:24px}
</style></head>
<body><main>
<header><div class="logo">U</div><div class="brand">UGB Connect</div></header>
<h1>${esc(d.title)}</h1>
<p class="meta">Version ${esc(d.version)} · mise à jour le ${esc(frDate(d.updatedAt))}</p>
<nav><strong>Sommaire</strong><ol>${toc}</ol></nav>
${sections}
<footer>
<p>Contact : <a href="mailto:${esc(contacts.email)}">${esc(contacts.email)}</a> · ${esc(contacts.phone)}</p>
<p>Voir aussi : <a href="/${other}">${esc(TITLES[other])}</a></p>
</footer>
</main></body></html>`;
}

/**
 * The pages, at the root (outside /api/v1): /confidentialite (/privacy), /conditions (/terms), and
 * /suppression-compte (the privacy policy, at « Supprimer ton compte ») for the store's deletion link.
 */
export function registerLegalPages(app: FastifyInstance, contacts: Contacts) {
  const page = (doc: LegalDoc) => async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.header('cache-control', 'public, max-age=3600').type('text/html; charset=utf-8').send(legalPage(doc, contacts));
  const hidden = { schema: { hide: true } };
  app.get('/confidentialite', hidden, page('confidentialite'));
  app.get('/privacy', hidden, page('confidentialite'));
  app.get('/conditions', hidden, page('conditions'));
  app.get('/terms', hidden, page('conditions'));
  app.get('/suppression-compte', hidden, async (_req, reply) => reply.redirect('/confidentialite#supprimer-ton-compte'));
}
