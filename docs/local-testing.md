# Recette locale des fonctionnalités 1 à 8

L’interface tourne sur `http://localhost:3000`. Les données, la réception email,
les appels Shopify et l’IA utilisent les services staging existants. Toute
modification dans l’interface locale est donc également visible en staging.

## Lancer

```sh
npm ci
npm run dev:connected
```

Le fichier ignoré `.env.staging` doit contenir `VITE_CONVEX_URL` et
`VITE_CONVEX_SITE_URL` du staging. Le script garde `.env.local` intact et ne lance
pas de serveur Convex de développement. Utiliser son compte HandleFast habituel.

## Tester

1. **Authentification** : se connecter, se déconnecter puis se reconnecter.
2. **Réception email** : dans les paramètres email de la boutique, copier l’adresse
   HandleFast et lui envoyer un message depuis sa propre boîte. Vérifier sa réception.
3. **Tri SAV** : envoyer une demande client puis un message commercial ; vérifier
   les espaces SAV / À vérifier / Hors SAV. Les corrections manuelles restent possibles.
4. **Shopify et colis** : vérifier la connexion dans les paramètres Shopify,
   actualiser les commandes, puis ouvrir un email mentionnant une référence de
   commande. La commande et son suivi apparaissent à côté ; l’association peut
   aussi être corrigée manuellement.
5. **Catégorie et importance** : ouvrir un email SAV, vérifier ses étiquettes,
   utiliser les filtres puis corriger une étiquette.
6. **Assistance humaine** : ouvrir une demande nécessitant une intervention,
   consulter le résumé et le brouillon, modifier le brouillon puis changer le
   statut À traiter / En cours / Traité.
7. **Réponse automatique** : configurer une règle pour une catégorie et une
   importance, puis envoyer une nouvelle demande de test depuis sa propre boîte.
   Contrôler le statut d’envoi et la réception de la réponse. L’activation concerne
   les nouveaux emails de toute la boutique ; désactiver la règle après la recette.
8. **Retards** : renseigner les délais et le calendrier de la boutique, conserver
   le mode simulation, lancer l’analyse puis consulter les candidats et les motifs
   de blocage. La simulation n’envoie aucun email.

Tous les traitements IA restent sur **GPT-6 Luna**.

## Limite 17TRACK

Le backend de staging utilise `TRACK17_TEST_NUMBERS`, une liste JSON d’au plus
**5 numéros déjà enregistrés**. Seuls ces numéros peuvent être enregistrés ou lus
auprès de 17TRACK, y compris après une synchronisation Shopify ou via le planificateur.
Les autres commandes et historiques déjà en cache restent visibles. Leur
actualisation peut afficher « 5 colis de test autorisés ».

Une liste vide, malformée ou de plus de cinq entrées bloque tous les appels de
suivi. L’absence de la variable rétablit le fonctionnement normal sans limite de
recette : conserver la variable pendant les tests. Les notifications entrantes
17TRACK continuent à mettre à jour les historiques existants sans appel sortant.

`LOCAL_TEST_ORIGINS` autorise explicitement `http://localhost:3000` et
`http://127.0.0.1:3000` pour l’authentification. Aucune autre origine locale ou
publique n’est acceptée par cette option ; l’adresse staging reste inchangée.
