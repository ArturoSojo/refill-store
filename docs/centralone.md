# Central One — proveedor de la tienda .com

Central One (API v1) **sustituye a FazerCards** en todo lo que vendía la tienda .com
(recargas y gift cards). **Inefable no cambia**: `free-fire` («Free Fire 20%»),
`freefire-id` («Free Fire ID»), `blood-strike` («Blood Strike Respaldo»),
`mobile-legends`, `honor-of-kings`, `marvel-rivals` y `roblox` siguen con sus productos y
su despacho de siempre.

| Archivo | Qué hace |
| --- | --- |
| `functions/src/services/centralOne.ts` | Cliente: catálogo, cobertura, saldo, validación, pedidos, códigos, webhook |
| `functions/src/services/centralOneCatalogSync.ts` | Sincronización del catálogo, retiro de FazerCards y extras de Free Fire |
| `functions/src/services/dispatch.ts` | Despacho, llaves idempotentes, códigos, pausa por saldo |
| `functions/src/routes/webhooks.routes.ts` | `POST /webhooks/centralone` |
| `functions/src/routes/admin.routes.ts` | Estado, cuenta, prueba del webhook, sync e historial |
| `web/src/pages/admin/CentralOnePanel.tsx` | Panel → Configuración → Central One |

> **No hay sandbox.** Cada `POST /orders` gasta saldo real. Para probar, el producto más
> barato y un ID real.

## Secretos

| Secreto | Uso |
| --- | --- |
| `CENTRAL_ONE_API_KEY` | Llave de la API. Permisos: `catalog:read`, `balance:read`, `orders:read`, `orders:write` y **`codes:read`** (sin él las gift cards se compran pero se quedan «en curso» esperando el código). |
| `CENTRAL_ONE_WEBHOOK_SECRET` | Secreto HMAC que muestra el portal al registrar el webhook. |

Los dos tienen que **existir** en Secret Manager para desplegar (`API_SECRETS`). Mientras no
haya valor real se pueden dejar en `PENDIENTE`: la llave se trata como «sin configurar» y el
webhook responde 503 (Central One reintenta).

```bash
firebase functions:secrets:set CENTRAL_ONE_WEBHOOK_SECRET
```

Funciones que montan la llave: `api`, `resolveDispatches`, `refundReviewOrders` y
`runCentralOneSync` (esta también `TELEGRAM_BOT_TOKEN` para sus avisos).

## Webhook

Registrar en el portal (Integración → Webhooks):

```
https://recargasrefillstore.com/api/webhooks/centralone
```

- Firma: `X-CentralOne-Signature` = `sha256=` + HMAC hex de `${timestamp}.${cuerpo}`,
  ventana de 300 s; también se acepta la firma «previous» durante una rotación.
- Duplicados: `providerWebhookEvents/{event_id}` (TTL de 7 días sobre `expireAt`).
- `order.*` → se localiza la orden por el índice `providerOrders` o por el código `RF-XXXXXX`
  de la llave idempotente, y se **vuelve a leer** `GET /orders/{id}` (el cuerpo del aviso no
  se usa como verdad).
- `product.price_changed` / `product.stock_changed` → actualiza costo, precio (salvo precio
  fijo), stock y disponibilidad de los productos `co-*` sincronizados.
- `balance.low` → aviso al equipo.
- Siempre responde en menos de 10 s; nunca se loguea el cuerpo.

El panel muestra la URL esperada, si el secreto está cargado, el último aviso recibido, lo que
Central One tiene registrado y sus últimas entregas, con un botón **Probar webhook**
(Central One permite 5 por hora a toda la cuenta).

## Sincronización del catálogo

- **Cada hora** (`syncCentralOneCatalog`) y desde **Panel → Configuración → Sincronizar
  ahora**. Las dos sólo encolan `providerSync/{id}`; el trigger `runCentralOneSync` la
  ejecuta (9 min, 1 GiB, una a la vez: `maxInstances: 1` y `concurrency: 1`). Encolar es
  atómico (transacción sobre `privateConfig/centralOneSyncLock`, compartida por el cron y el
  panel): si hay una en cola o corriendo de menos de 15 min no se encola otra; las más
  viejas se cierran como error.
- Si falla la cobertura de validación, los juegos que ya existen conservan su
  `validatesPlayerId` (los nuevos nacen sin él hasta la próxima sync).
- Un juego por par (`product_family_id`, región): `co-topup-…` / `co-gift_card-…`. Producto:
  `${gameId}--${product_id}`.
- Se descartan: inactivos, categorías que no sean `gaming_topup`/`gift_card`, los que piden
  contraseña, recargas sin campos del jugador, monedas distintas de USD, duplicados y
  regiones fuera de Latinoamérica (EE. UU. sí en gift cards).
- **Freno de seguridad**: catálogo vacío o una familia con ≥ 20 juegos activos que llega con
  menos de la mitad → no se escribe nada (`empty_catalog` / `catalog_suspicious`).
- Sólo una sync **completa** marca retirados (`providerRemoved`, `hiddenReason:
  'provider_removed'`), retira FazerCards y crea los extras de Free Fire.
- Los juegos con `manual: true` nunca se tocan, ni ningún doc con un id `co-*` que no sea de
  `provider: 'centralone'` (p. ej. creado a mano con otro proveedor).

### Qué decide el admin y qué decide la sync

| Campo | Quién manda |
| --- | --- |
| Nombre, imágenes, colores, orden y `active` del **juego** | El admin (la sync sólo los pone al crearlo) |
| Etiquetas y ayudas de los campos del jugador | El admin (la sync añade/quita claves y actualiza listas) |
| Costo, stock, `calls`, `targetFields` | Central One |
| Precio | Margen por defecto, salvo **Precio fijo** (`priceLocked`). Si el costo supera el precio fijo se recalcula igual |
| `active` del **producto** | Disponible en Central One **y** no apagado a mano (`adminDisabled`) |

Editar el precio en el panel lo fija (también el interruptor **Precio fijo** sin cambiar el
precio, y **Recalcular precios** en masa); el interruptor **Apagado a mano** lo apaga aunque
ya estuviera agotado en Central One, y la sync no lo vuelve a encender.

Los avisos `product.*` llevan un reloj por precio y otro por stock, y no se aplica nada
anterior a la última escritura de la sync (`providerSyncedAt`).

## Retiro de FazerCards (una sola vez)

Tras la primera sync completa con recargas y gift cards mapeadas, los juegos `fz-*` (salvo
los manuales) quedan `active: false`, `providerRemoved: true`, `hiddenReason:
'provider_migrated'`, y sus productos apagados. **No se borra nada**: las órdenes viejas y el
espejo de WhatsApp los referencian, y el despacho/consulta de FazerCards sigue funcionando
para ellas. La marca queda en `privateConfig/centralOne.fazerRetiredAt`. La ruta de sync de
FazerCards responde 410.

## Free Fire

Hay tres:

1. `free-fire` (Inefable, 20 %) y 2. `freefire-id` (Inefable, ID): a cada uno se le **añaden**
   (productos nuevos, nunca se editan los existentes) los pases y la subida de nivel de
   Central One que no tengan ya, y el combo «Subida de Nivel Completo». Las tarjetas
   semanal/mensual se crean **apagadas**.
3. El Free Fire LATAM de Central One (`co-topup-…`, id en
   `privateConfig/centralOne.freeFireLatamGameId`) con todo su catálogo. Se crea
   **desactivado**: se activa a mano desde el panel.

Cada extra creado queda en `privateConfig/centralOne.extras`; si el admin lo borra, no se
vuelve a crear, tampoco con otro id para el mismo `packageId` (un extra de catálogo
`freefire-id--co-…` y un clon `freefire-id--ff-co-…` se cubren entre sí). Una oferta sin stock
en Central One no se crea como extra hasta que vuelva.

Los extras **no se resincronizan** (precio y stock quedan como se crearon). Si Central One
sube su costo hasta el precio, o los retira o agota, el webhook y la sync avisan al equipo
(«Revisa extras de Free Fire» / «Extras de Free Fire a pérdida»): hay que subirles el precio
o apagarlos a mano.

## Despacho

- Cada unidad es un pedido de `quantity: 1`. Las recargas de los juegos `co-*` y los extras
  de Free Fire se compran **de a una por orden**; las gift cards admiten varias. Los
  productos de Central One sembrados en juegos de Inefable (oro de `blood-strike`,
  `ff-co-nivel-*`, Booyah) conservan el tope de siempre.
- Llave idempotente por llamada: `RF-XXXXXX-{n}`. Sólo se rota (`-r{intento}`) cuando
  Central One confirma que el pedido anterior cerró sin entregar. Un resultado ambiguo (red,
  5xx, 429, 409 de llave) **no** rota: el cron reintenta con la misma llave hasta 3 veces y
  después pasa a revisión con «El pedido pudo haber entrado en Central One…».
- Al rotar, el pedido anterior queda en `previousProviderOrderIds` de la llamada. Si Central
  One lo entrega tarde, el webhook avisa en crítico («Central One cobró dos veces» /
  «Entrega tardía de Central One»), y mientras esté abierto o entregado la revisión vencida
  no reembolsa la orden.
- Las escrituras de `dispatch.calls` (cron, webhook, reintento del panel, consulta de
  estado) son compare-and-set por llamada, y antes de comprar con llave nueva se relee la
  orden: una copia vieja nunca deshace una compra más nueva.
- **Saldo insuficiente**: la orden se queda despachando (sin reembolso automático), aviso
  crítico como mucho cada hora, reintento en cada pasada; a las 24 h pasa a revisión.
- Gift cards: no se completan sin códigos (`GET /orders/{id}/codes`). Los códigos por llamada
  se guardan en `orders/{id}/private/delivery` (sólo Admin SDK; el panel los ve por su API) y
  pasan a `order.deliveredCodes` al completarse la orden; nunca a `providerResponse` ni a los
  logs. Así una gift card entregada a medias y luego reembolsada no deja el código a la vista.
- Un `missing_config` o un fallo de red al consultar **no** cuenta como «no encontrada»: el
  reembolso automático de órdenes en revisión espera.

## Runbooks

**El panel dice «Falta clave».** Revisar `CENTRAL_ONE_API_KEY` en Secret Manager y volver a
desplegar las funciones.

**Gift card «en curso» con mensaje de `codes:read`.** Añadir el permiso a la llave en el
portal; el cron recoge los códigos en la siguiente pasada.

**Sync con error `catalog_suspicious` / `empty_catalog`.** No se tocó nada. Revisar el estado
de Central One y relanzar desde el panel cuando el catálogo vuelva completo.

**Webhook sin avisos.** Comparar en el panel la URL registrada con la esperada, confirmar que
el secreto está cargado y pulsar **Probar webhook**. Mientras tanto el cron
`resolveDispatches` cierra las órdenes igual (cada 2 min).

**Saldo insuficiente.** Recargar saldo en Central One: las órdenes en pausa salen solas en la
siguiente pasada del cron.
