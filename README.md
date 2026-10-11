# Voertuigenbord logistiek – op je eigen server

Live bord voor voertuigen en ritten, met inloggen per gebruiker, rollen en meerdere evenementen. Alle schermen zien dezelfde gegevens, live.

Nodig: **Node.js 18 of nieuwer** (of Docker). Er zijn geen extra pakketten nodig.

## Bijwerken vanaf het oude Busbord (Unraid + Portainer)

1. Stop de stack `busbord` in Portainer.
2. Zet de nieuwe bestanden in `/mnt/user/appdata/busbord`: vervang `server.js` en de hele map `public/`. Laat de map `data/` staan.
3. Start de stack weer.

Bij de eerste start gebeurt het volgende vanzelf:

- Je bestaande ritten, bussen en logboek worden één evenement: *Menzis 4 Mijl van Groningen*.
- Er komt één admin-account bij, met de gebruikersnaam en het wachtwoord uit `BUSBORD_USER` en `BUSBORD_PASSWORD` in de stack. Daarna hebben die twee variabelen geen functie meer; wachtwoorden wijzig je in het tabblad **Gebruikers**.
- Het browservenster om in te loggen is weg. Je krijgt nu een eigen inlogpagina.

Controleren in de logs van de container: je ziet *Eerste beheerder aangemaakt* en *Oude gegevens omgezet naar evenement*.

## Snel starten (zonder Docker)

```bash
cd /opt/busbord
BUSBORD_USER=admin BUSBORD_PASSWORD=een-sterk-wachtwoord node server.js
```

Open daarna `http://<server-ip>:8080`.

## Instellingen

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `8080` | Poort |
| `HOST` | `0.0.0.0` | Adres om op te luisteren |
| `DATA_DIR` | `./data` | Map met `busbord.json`, `users.json`, `sessions.json` en `backups/` |
| `BUSBORD_USER` / `BUSBORD_PASSWORD` | `admin` / willekeurig | Alleen bij de allereerste start: het eerste admin-account. Zonder wachtwoord staat een gegenereerd wachtwoord in de log. |

## Rollen

| Rol | Mag |
|---|---|
| Admin | Alles: gebruikers beheren, evenementen verwijderen, ritten terugzetten, alles leegmaken |
| Coördinator | Alles behalve resetten en gebruikersbeheer |
| Centralist | Ritten aanmaken, wijzigen en doorzetten; status en notitie van voertuigen; logregels toevoegen. Niets verwijderen |
| Chauffeur | Telefoonweergave: eigen ritten zien en doorzetten, rit aanmaken op het eigen voertuig, bellen met de meldkamer |
| Waarnemer | Alleen meekijken |

De server controleert de rechten bij elke wijziging. Een chauffeur krijgt van de server alleen de ritten van zijn eigen voertuig binnen; iemand ziet alleen de evenementen die bij zijn account zijn aangevinkt.

## Inloggen met QR-code

In het tabblad **Gebruikers** maakt de admin per gebruiker een inlog-QR-code (kolom *Inlog-QR*). Scannen met de camera van de telefoon logt direct in, zonder wachtwoord. De code kun je afdrukken, vernieuwen (de oude werkt dan niet meer) of intrekken. Wie de code heeft, kan inloggen: behandel hem als een wachtwoord.

## Automatische updates

De server haalt zelf nieuwe versies op van GitHub (`DGerding-2307/busbord`, branch `main`).

- Elk half uur kijkt hij of er een nieuwe versie is. Die wordt alleen geïnstalleerd **tussen 03:00 en 05:00** of **als niemand online is**, zodat een update nooit midden in een dienst gebeurt.
- Bijwerken = `server.js`, `package.json` en de map `public/` vervangen. De map `data/` wordt nooit aangeraakt. Elk bestand wordt gecontroleerd tegen GitHub voordat het wordt geplaatst; de oude versie gaat naar `data/updates/`.
- Daarna stopt de server en start Docker hem opnieuw (daarvoor is `restart: unless-stopped` nodig, zoals in de stack). Open schermen laden vanzelf de nieuwe versie zodra niemand iets aan het invullen is.
- In **Instellingen → Updates** (alleen admin) zie je de versie, kun je automatisch bijwerken uitzetten en kun je direct controleren of bijwerken.
- Uitzetten kan ook met `AUTO_UPDATE=uit` in de stack. Bij een privé-repository zet je een `GITHUB_TOKEN` (alleen leesrechten) in de stack.
- Terug naar de vorige versie: stop de stack, kopieer de bestanden uit de nieuwste map in `data/updates/` terug en start de stack.

Let op: wie kan pushen naar de GitHub-repository, kan code op je server laten draaien. Geef dus niemand anders schrijfrechten op die repository.

## Kaarten

Tabblad **Kaarten**: per evenement meerdere pdf-kaarten (plattegrond, routes, parkeren). Admin en coördinator voegen ze toe (meerdere tegelijk), geven ze een naam en omschrijving en zetten ze op volgorde. Iedereen met toegang tot het evenement, ook chauffeurs, kan ze bekijken; op een telefoon openen ze in de eigen pdf-weergave met inzoomen.

## Meldingen op telefoon en pc

Iedere gebruiker zet meldingen per apparaat aan: via zijn naam rechtsboven (of Instellingen) → **Meldingen aanzetten**. Je krijgt dan een melding als een rit die je mag zien van fase verandert, bij alle evenementen waar je toegang toe hebt, ook als het bord dicht is. Alleen als je de afgelopen 60 minuten online was, niet voor je eigen wijzigingen, en niet als het bord op dat moment open en in beeld is (dan hoor je het pingeltje). Tik op de melding om de rit te openen.

- Werkt in Chrome, Edge, Firefox (pc en Android) en Safari op de Mac.
- iPhone/iPad (iOS 16.4 of nieuwer): eerst in Safari **Deel → Zet op beginscherm**, het bord vanaf het beginscherm openen en daar meldingen aanzetten.
- Alleen via HTTPS. De server stuurt meldingen via de pushdienst van Google, Mozilla, Apple of Microsoft; de inhoud is versleuteld. De sleutels staan in `data/push.json`.
- Na een herstart van de server telt "online" opnieuw vanaf het moment dat iemand het bord weer opent.

## Veiligheid

Wat de server zelf doet:
- Rechten per rol worden op de server gecontroleerd, niet alleen in de app. Een chauffeur krijgt alleen de gegevens van zijn eigen voertuig binnen.
- Alle opgeslagen waarden worden gecontroleerd (fase, status, tijden, datums, veldnamen), zodat niemand via een rit of voertuig code in andermans scherm kan zetten.
- Inloggen: na 8 foute pogingen per gebruikersnaam en adres, 30 per adres of 20 per account volgt 5 minuten wachten.
- Sessiecookie is HttpOnly en SameSite; via HTTPS ook Secure. Wijzigingen accepteren alleen JSON, dus een vreemde website kan niets namens je opslaan.
- Beveiligingsheaders tegen inbedden in andere sites en het raden van bestandstypes. Pdf-bijlagen openen in een afgeschermde weergave; alleen echte pdf's tot 20 MB, samen maximaal 2 GB.
- Een kapot verzoek laat de server niet meer vallen.

Wat jij moet doen:
- **Wachtwoord admin**: de app toont een melding zolang het wachtwoord korter is dan 8 tekens of een standaardwachtwoord is (zoals `verander-dit-wachtwoord`). Wijzig het in **Gebruikers**.
- **Alleen via HTTPS naar buiten**: laat internet alleen via je reverse proxy (Nginx Proxy Manager of Cloudflare Tunnel) binnenkomen. Zet geen port forward op poort 8085 van je router.
- **Map `appdata/busbord/data`** bevat leesbare wachtwoorden, QR-codes en back-ups. Deel die map niet via SMB en zet hem niet in een gedeelde cloudmap.
- Trek na het evenement inlog-QR-codes in en zet accounts van tijdelijke vrijwilligers uit.

## Gegevens en back-ups

- `data/busbord.json`: evenementen, voertuigen, ritten, logboek.
- `data/users.json`: gebruikers. **Wachtwoorden staan hier leesbaar in**, zodat de admin ze kan opzoeken. Geef dus niemand anders toegang tot deze map, en gebruik voor dit bord geen wachtwoorden die mensen ook elders gebruiken.
- `data/sessions.json`: wie ingelogd is (30 dagen geldig).
- Elke 10 minuten (bij wijzigingen) en voor elke reset komt er een kopie in `data/backups/`.
- Terugzetten: stop de server, kopieer een back-up naar `data/busbord.json` (of `users.json`), start de server.
- Admin-wachtwoord kwijt: stop de server, zoek het op in `data/users.json` of pas het daar aan, start de server.

## HTTPS

Zet er een reverse proxy voor (Nginx Proxy Manager, Caddy, Cloudflare Tunnel). Buffering moet uit voor de live updates:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## Excel zonder internet

```bash
curl -L -o public/vendor/xlsx.full.min.js https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
```

## Goed om te weten

- Thema (standaard licht), meldingen en filter stel je per apparaat in.
- Server draait? `http://<server>:8080/healthz`.
- Na 8 verkeerde inlogpogingen op één gebruikersnaam moet je 5 minuten wachten.
