# Wie dieses Repo ausgerollt wird

Ein Push auf `master` deployt nach https://docmint.app.mintapis.com. Das ist seit
dem 30.08.2026 wieder wahr und war es davor monatelang nicht.

## Was kaputt war

Coolify meldete `is_auto_deploy_enabled = true`, aber dieses Repo hatte **keinen
einzigen Webhook**, und die Coolify-Instanz hatte keinen FQDN — GitHub hätte also
gar keine Adresse gehabt, an die es hätte zustellen können. Der Ausfall war
beidseitig lautlos: der Push wurde grün quittiert, Coolifys Warteschlange blieb
leer, der Container bediente weiter den vorherigen Commit.

## Wie es jetzt läuft

GitHub stellt `push`-Ereignisse an
`https://coolify.app.mintapis.com/webhooks/source/github/events/manual` zu,
signiert mit dem anwendungseigenen HMAC-Secret.

Unter diesem Namen ist **ausschließlich** der Pfad `/webhooks/` erreichbar;
Dashboard und API antworten dort mit 404 und bleiben an `127.0.0.1:8000`
gebunden. Coolify darf auf diesem Host alles ausrollen — die ganze Steuerungsebene
zu exponieren wäre der falsche Preis für einen Deploy-Trigger gewesen.

## Wenn ein Deploy von Hand nötig ist

```bash
sudo docker exec coolify php artisan tinker --execute="
  \$app = App\Models\Application::where('uuid','fvcw7spr3oj1xobjibvtjnsl')->first();
  \$uuid = (string) new Visus\Cuid2\Cuid2();
  queue_application_deployment(application: \$app, deployment_uuid: \$uuid, is_api: true);
  echo \$uuid;"
```

Ob er durch ist, sagt der Image-Tag des laufenden Containers — nicht die
Warteschlange allein.
