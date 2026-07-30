# Refill Store

Plataforma web de recargas para **Free Fire** y **Blood Strike**, optimizada para móviles.
Automatiza todo el ciclo: el cliente elige el paquete, paga con **Pago Móvil BDV**, el
backend verifica la referencia contra el banco (**API Pabilo**) y despacha la recarga
(**API Inefable**) o genera el enlace de WhatsApp cuando el producto es manual.

Proyecto Firebase: **`refill-e254f`**

---

## Índice

- [Arquitectura](#arquitectura)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Puesta en marcha](#puesta-en-marcha)
- [Despliegue](#despliegue)
- [Flujo de compra](#flujo-de-compra)
- [Catálogo](#catálogo)
- [Panel de administración](#panel-de-administración)
- [Seguridad](#seguridad)
- [API](#api)
- [Desarrollo local](#desarrollo-local)

---

## Arquitectura

```
Navegador (React + TS)
      │  ID token de Firebase en cada petición
      ▼
Firebase Hosting  ──/api/**──►  Cloud Function `api` (Express + TS)
      │                              │
      │                              ├──► API Pabilo    (verifica el Pago Móvil)
      │                              ├──► API Inefable  (despacha la recarga)
      │                              └──► Firestore     (órdenes, catálogo, usuarios)
      │
      └── Firestore en tiempo real (sólo lectura del propio usuario)
```

Decisiones que vale la pena conocer:

- **Las claves de Pabilo e Inefable jamás llegan al navegador.** Viven en Google Secret
  Manager y sólo las lee la Cloud Function. Un frontend que llamara directamente a esas
  APIs expondría las credenciales a cualquiera que abriera las DevTools.
- **El cliente no escribe nada con valor económico.** Las reglas de Firestore le permiten
  leer sus órdenes (para ver el estado en vivo) y editar cuatro campos cosméticos de su
  perfil. Precios, estados de pago, saldos y roles sólo los toca el backend.
- **El monto en bolívares se congela al crear la orden.** Si la tasa cambia mientras el
  cliente está en la app del banco, se le sigue exigiendo —y verificando— el monto que vio.
- **El rol vive en los custom claims del token**, no en el documento del usuario, para que
  no se pueda escalar privilegios escribiendo en Firestore.

## Estructura del repositorio

```
refill-store/
├── firebase.json            Hosting + Functions + reglas + emuladores
├── firestore.rules          Reglas de seguridad (cierre por defecto)
├── firestore.indexes.json   Índices compuestos de las consultas del panel
├── storage.rules            Imágenes de catálogo y comprobantes
├── scripts/setup.mjs        Arranque: admin inicial + siembra del catálogo
│
├── functions/               API (Cloud Functions v2, Express, TypeScript)
│   └── src/
│       ├── index.ts             Exporta `api`, `expireOrders`, `refreshRate`
│       ├── app.ts               Montaje de Express y CORS
│       ├── config/              Secretos (env.ts) y Admin SDK (firebase.ts)
│       ├── lib/                 Errores, dinero, HTTP, IDs, logging
│       ├── middleware/          Autenticación, rate limit, errores
│       ├── routes/              public · orders · me · admin · setup
│       ├── services/            Lógica de negocio (ver abajo)
│       ├── seed/                Catálogo del documento técnico
│       └── types/models.ts      Modelos de dominio
│
└── web/                     Tienda + panel (React 18, Vite, Tailwind)
    └── src/
        ├── App.tsx              Rutas
        ├── lib/                 Firebase, cliente de API, formato, utilidades
        ├── providers/           Sesión (AuthProvider) y configuración
        ├── hooks/               Catálogo, órdenes, cuenta, panel
        ├── components/          UI, layouts y piezas comunes
        ├── features/checkout/   Los tres pasos de la compra
        ├── pages/               Tienda y área de cuenta
        └── pages/admin/         Panel de administración
```

Servicios del backend:

| Servicio          | Responsabilidad                                                   |
| ----------------- | ----------------------------------------------------------------- |
| `orders.ts`       | Crear orden, verificar pago, cancelar, reembolsar, expirar         |
| `dispatch.ts`     | Ejecutar la secuencia de llamadas al proveedor y reintentos        |
| `pabilo.ts`       | Verificación del Pago Móvil (`is_new`)                            |
| `inefable.ts`     | Despacho de recargas                                              |
| `whatsapp.ts`     | Mensaje y enlace precargado de los productos manuales             |
| `catalog.ts`      | Juegos y productos, validación de compra y de ID de jugador       |
| `settings.ts`     | Configuración de la tienda con caché corta                        |
| `rate.ts`         | Tasa Bs/USD manual o automática, con historial                    |
| `coupons.ts`      | Validación y consumo de cupones                                   |
| `users.ts`        | Perfiles, roles, niveles, saldo y referidos                       |
| `stats.ts`        | Agregados diarios para el dashboard                               |
| `audit.ts`        | Bitácora de acciones sensibles                                    |

## Puesta en marcha

### 1. Requisitos

- Node.js 20 o superior
- Firebase CLI (`npm i -g firebase-tools`) y sesión iniciada (`firebase login`)
- **Plan Blaze activado en `refill-e254f`** — Cloud Functions v2 lo exige. El consumo real
  de esta aplicación cae dentro de la cuota gratuita, pero sin Blaze las funciones no
  despliegan.

### 2. Instalar dependencias

```bash
npm run install:all
```

### 3. Activar los métodos de acceso

En la [consola de Firebase](https://console.firebase.google.com/project/refill-e254f/authentication/providers):
**Authentication → Sign-in method**. Habilita **Google** y **Correo/contraseña**. Es un
paso manual que no se puede automatizar desde el CLI.

> En `refill-e254f` el acceso con correo y contraseña ya está habilitado.

Añade también tu dominio en **Authentication → Settings → Authorized domains**
(`refill-e254f.web.app` ya viene autorizado).

### 4. Crear la base de datos

**Firestore Database → Crear base de datos → modo producción**, región `us-central` (la
misma que las funciones, para que las lecturas no crucen regiones).

### 5. Cargar los secretos

```bash
firebase functions:secrets:set PABILO_API_KEY
firebase functions:secrets:set PABILO_USER_BANK_ID
firebase functions:secrets:set INEFABLE_API_KEY
firebase functions:secrets:set SETUP_TOKEN      # inventa una cadena larga
```

Los valores de los tres primeros están en el documento de especificaciones.
`SETUP_TOKEN` es temporal: lo borras en cuanto tengas tu administrador.

### 6. Desplegar

```bash
npm run deploy
```

### 7. Dejar la tienda operativa

Con contraseña (crea la cuenta aunque no exista):

```bash
SETUP_TOKEN=el-token-que-inventaste \
  npm run setup -- --email=admin@tudominio.com --password='UnaClaveLarga123!'
```

O con una cuenta de Google que ya haya entrado una vez a la web:

```bash
SETUP_TOKEN=el-token-que-inventaste npm run setup -- --email=tucorreo@gmail.com
```

Cualquiera de las dos crea `config/app`, siembra el catálogo completo del documento
técnico y concede el rol de administrador.

Si vas contra la API local en vez de la desplegada, añade
`API_BASE_URL=http://127.0.0.1:5051/refill-e254f/us-central1/api`.

1. **Cierra sesión y vuelve a entrar** para que tu token recoja el rol nuevo.
2. Borra el secreto de arranque:

```bash
firebase functions:secrets:destroy SETUP_TOKEN
```

5. Entra a `/admin` y revisa la tasa del día en **Configuración**.

## Despliegue

En producción el proyecto vive partido en dos:

| Parte                | Dónde                | URL                                                     |
| -------------------- | -------------------- | ------------------------------------------------------- |
| Frontend (SPA)       | **Netlify**          | https://refill-store-ve.netlify.app                     |
| API                  | **Cloud Functions**  | https://us-central1-refill-e254f.cloudfunctions.net/api |
| Auth, Firestore      | Firebase             | proyecto `refill-e254f`                                 |

La API no puede estar en Netlify porque es la que guarda los secretos de Pabilo e Inefable
y la que habla con Firestore mediante el Admin SDK.

**El puente entre las dos partes es un proxy**, definido en `netlify.toml`:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://us-central1-refill-e254f.cloudfunctions.net/api/:splat"
  status = 200      # reescritura, no redirección
  force = true
```

Con `status = 200` Netlify reenvía la petición en el servidor: el navegador siempre pide
rutas del mismo dominio. Eso significa que el frontend usa rutas relativas (`/api/config`)
igual que en local, sin ninguna URL absoluta ni variable de entorno para la API, y sin
preflight de CORS en el navegador.

> Aun así, la función **sí** valida el `Origin`: en los POST el navegador manda esa cabecera
> incluso al mismo origen, y Netlify la reenvía tal cual. Por eso el dominio de Netlify y sus
> subdominios de vista previa están en la lista blanca de `functions/src/config/env.ts`.

### Frontend (automático)

Netlify está conectado al repositorio: **cada push a `main` construye y publica**. La
configuración del build vive en `netlify.toml` (base `web/`, `npm run build`, publica `dist`).

Como `web/.env` no se versiona, las variables `VITE_FIREBASE_*` están configuradas en
Netlify. Si cambian, hay que actualizarlas allí además de en local:

```bash
netlify link --id <site-id>     # una vez por máquina
netlify env:set VITE_FIREBASE_API_KEY "…"
```

Despliegue manual, si hace falta:

```bash
npm run build:web && netlify deploy --prod --dir web/dist
```

### API y reglas

```bash
npm run deploy:api      # sólo las funciones
npm run deploy:rules    # sólo reglas e índices de Firestore
```

Los secretos ya están en Secret Manager. Para rotarlos:

```bash
printf '%s' 'nuevo-valor' | firebase functions:secrets:set PABILO_API_KEY --data-file -
npm run deploy:api      # hay que redesplegar para que tome la versión nueva
```

### Dominios autorizados

Para que el login con Google funcione, el dominio debe estar en **Authentication → Settings
→ Authorized domains**. Ahora mismo: `localhost`, `refill-e254f.firebaseapp.com`,
`refill-e254f.web.app` y `refill-store-ve.netlify.app`. Si conectas un dominio propio en
Netlify, hay que añadirlo también ahí y a la lista de orígenes de la API.

## Flujo de compra

```
[Elegir juego] → [Elegir paquete] → [Escribir ID de jugador]
                                          │
                                    ¿sesión iniciada?
                                    no → login con Google
                                          │
                                    [Crear orden]  ← congela monto en Bs y tasa
                                          │
                        [Pantalla de pago: banco, cédula, teléfono, monto exacto]
                                          │
                                 [Cliente pega la referencia]
                                          │
                     ┌────── candado local sobre la referencia ──────┐
                     │            POST a Pabilo (is_new)             │
                     └───────────────────┬───────────────────────────┘
                                         │
                   is_new = false ───────┴─────── is_new = true
                          │                              │
                  [Pago rechazado]              ¿modalidad del producto?
                                                 │                   │
                                          AUTOMÁTICO             MANUAL
                                                 │                   │
                                    llamadas a Inefable     enlace de WhatsApp
                                    en secuencia            con mensaje precargado
                                                 │                   │
                                          [Completada]      [Esperando gestión]
```

### Detalles que importan

> ### ⚠️ El PDF del proyecto describe mal la API de despacho
>
> La referencia buena es `API_DOCS.txt`, la documentación oficial del proveedor. El PDF
> del proyecto se equivoca en la ruta y, sobre todo, en el significado de `product_id`:
>
> | | PDF del proyecto | Real (verificado) |
> | --- | --- | --- |
> | Ruta | `/api/v1/order` | `/api/v1/recharge` |
> | `product_id` | el paquete | **el `game_id`** (−1 Free Fire ID, 15 Blood Strike) |
> | `package_id` | no lo menciona | el paquete (1-6 en Free Fire) |
>
> **`product_id` no es opcional en la práctica.** Los `package_id` se repiten entre juegos,
> así que sin él el proveedor empareja el paquete con otro juego. Ese fue el origen de un
> error desconcertante: pedir el paquete 1 sin `product_id` devolvía
> `"Validación falló: Please insert Zone ID into input2"` —el paquete caía en un juego que
> pide Zone ID—. Con `product_id: -1` el mismo paquete enruta bien.
>
> Campos del cuerpo:
>
> ```json
> {
>   "product_id": -1,              // game_id del catálogo
>   "package_id": 1,               // paquete
>   "player_id": "3363122817",
>   "player_id2": "…",             // opcional: Zone ID en juegos que lo piden
>   "external_order_id": "RF-9K4BWD-1"
> }
> ```
>
> **`external_order_id` evita cobros dobles.** Si la petición se corta por timeout y se
> reintenta con el mismo valor, el proveedor devuelve el resultado de la original en lugar
> de comprar otra recarga. Aquí se usa `{código de orden}-{n.º de llamada}`, que es estable
> entre reintentos y distinto para cada parte de un combo. Ante un timeout, lo correcto es
> consultar `GET /api/v1/order-status?external_order_id=…` antes de reintentar.
>
> **Cuidado con `game_id: -3` (Free Fire Global): entrega un PIN, no una recarga directa.**
> El código llega en `reference_no` y hay que canjearlo a mano. Para recargar la cuenta del
> jugador directamente hay que usar `-1` (Free Fire ID).
>
> Dos detalles de la respuesta que importan:
>
> - Una entrega correcta responde `status: "completada"` (no "exitosa") y `ok: true`.
> - **Una recarga fallida también devuelve `order_id`.** Por eso el éxito se decide por el
>   booleano `ok`, nunca por la presencia de `order_id`. Cuando falla, el proveedor devuelve
>   el saldo automáticamente.
>
> La ruta es configurable con `INEFABLE_RECHARGE_PATH` por si el proveedor la mueve.

**Combos.** Un combo son varias llamadas encadenadas. Para *830 + 83 💎* se envía
`product_id: 3`, se confirma que la respuesta sea exitosa y sólo entonces se envía
`product_id: 2`. Si la segunda falla, la primera ya llegó al jugador: por eso cada llamada
se guarda con su propio estado y **el reintento del panel sólo repite las que quedaron en
error**. Repetir una llamada exitosa sería regalar diamantes.

**Referencias duplicadas.** `is_new` de Pabilo protege contra reutilizar una referencia ya
consumida, pero no contra dos peticiones simultáneas con la misma referencia: ambas verían
`is_new: true`. Por eso, antes de llamar a Pabilo se toma un candado en
`paymentRefs/{referencia}`; si la verificación falla, el candado se libera para que el
dueño legítimo de esa referencia pueda usarla.

**Proveedor caído.** Si Pabilo no responde, la orden vuelve a *esperando pago* y el cliente
puede reintentar. Nunca se rechaza un pago por un fallo de red: el dinero pudo haber salido.

**Órdenes sin pagar.** Caducan a los 30 minutos (configurable). Una tarea programada las
marca como expiradas cada 15 minutos.

## Catálogo

Transcrito del documento técnico en `functions/src/seed/catalog.seed.ts`.

**Free Fire** — `game_id: -1`, `game_type: freefire_id`

| Producto        | package_id | Costo   |
| --------------- | ---------- | ------- |
| 100 + 10 💎     | 1          | $0,699  |
| 310 + 31 💎     | 2          | $2,110  |
| 520 + 52 💎     | 3          | $3,595  |
| 1.060 + 106 💎  | 4          | $6,658  |
| 2.180 + 218 💎  | 5          | $13,100 |
| 5.600 + 560 💎  | 6          | $34,100 |

Combos: 200+20 (`1` ×2), 410+41 (`2`+`1`), 620+62 (`3`+`1`), 830+83 (`3`+`2`).

**Blood Strike** — `game_id: 15`, `game_type: dynamic`
Paquetes `112, 96, 97, 98, 99, 100, 101` con los costos del documento.

**Productos manuales** (Categoría B): pases y tarjetas de ambos juegos. No se envían al
proveedor; tras verificar el pago se genera el enlace de WhatsApp.

> **Sobre los precios de venta:** el documento sólo especifica **costos**. Al sembrar, el
> precio de venta se calcula aplicando el **margen por defecto (25 %)** redondeado a
> múltiplos de 5 centavos. Ajústalos en **Panel → Productos**, uno a uno o en masa con
> *Recalcular precios*.

## Marca

El arte original vive en `assets-src/` (no se sirve al navegador) y de ahí se generan las
versiones optimizadas en `web/public/brand/`:

```bash
npm run brand
```

Fuentes activas:

| Archivo                 | Contenido                                          |
| ----------------------- | -------------------------------------------------- |
| `hero-2.png`            | Banner completo: rojo neón sobre circuito oscuro    |
| `refill-store-icon.png` | Emblema suelto, con transparencia                   |
| `refill-store-logo.png` | Emblema + rótulo «REFILL STORE», con transparencia  |

Salidas:

| Recurso                     | Uso                                                     |
| --------------------------- | ------------------------------------------------------- |
| `hero-*.webp` / `.jpg`      | Fondo del hero de la portada (tres anchos + respaldo)   |
| `emblem-{128,256,512}`      | Cabecera, panel y pantalla de «recarga entregada»       |
| `wordmark-{320,640}`        | Emblema + rótulo: login y pie de página                 |
| `app-icon-*.png`            | Favicon, pantalla de inicio y manifiesto PWA            |
| `app-icon-maskable-512.png` | Icono adaptable de Android (recorta hasta un 20 %)      |
| `logo-light-900.jpg`        | Sobre fondo claro, para facturas o correos              |

Tres decisiones que explican los formatos:

**El emblema y el rótulo salen directos del arte, sin recortes ni trucos.** Llegan con canal
alfa real, así que se pintan tal cual sobre el tema oscuro. (Una versión anterior de la marca
venía sobre fondo blanco opaco y había que recortarla del banner y esconder el fondo con
`mix-blend-mode`; eso ya no hace falta.)

**El emblema va en PNG además de WebP.** Aquí sí se necesita transparencia, y como el arte es
vectorial y plano comprime muy bien: 15 KB a 256 px. El banner, en cambio, es fotográfico y
opaco, así que su respaldo es JPEG.

**El banner pesa 50 KB en lugar de 6,3 MB.** El original es un PNG de 2632 × 1606; se sirve
como WebP en tres anchos. En total los recursos de marca ocupan **0,63 MB**.

El encuadre del hero recorta a propósito la franja inferior del banner, donde el arte lleva
rotulado «REFILL STORE»: sin ese recorte el nombre aparecería dos veces en pantalla, una en
la cabecera y otra detrás del titular.

### Paleta

Los colores salen del propio logotipo, muestreados del archivo:

| Token           | Valor     | Uso                                                      |
| --------------- | --------- | -------------------------------------------------------- |
| `neon-red`      | `#F03030` | Rojo de la marca: rellenos, bordes, degradado principal   |
| `neon-crimson`  | `#FF5A52` | Rojo aclarado para TEXTO sobre oscuro (contraste)         |
| `neon-ember`    | `#B01B1B` | Rojo apagado para sombras                                 |
| `neon-blue`     | `#3018F0` | Azul del logotipo (cruceta y boca): acento secundario     |
| `neon-ice`      | `#5B8CFF` | Azul aclarado, legible y visible en gráficos              |

Dos reglas que conviene respetar al añadir pantallas:

- **El rojo de marca no se usa para estados.** En la escala de estados de una orden el rojo
  significa «pago rechazado»; por eso «enviando recarga» va en índigo y no en rojo, que se
  leería como un fallo. Lo mismo con las medallas de nivel, que llevan color de metal o gema.
- **En gráficos se usa `neon-ice`, no `neon-blue`.** El azul del logotipo es muy oscuro y
  sobre el fondo casi negro del panel una serie pintada con él resulta invisible.

## Panel de administración

Ruta `/admin`, visible para roles `staff` y `admin`.

| Sección           | Qué permite                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| **Resumen**       | Ingresos, utilidad, órdenes, usuarios, gráficos, top de productos y alertas activas |
| **Órdenes**       | Filtrar, buscar por código/ID/referencia, exportar CSV                              |
| Detalle de orden  | Reintentar despacho, completar manualmente, reembolsar, nota interna, historial      |
| **Productos**     | CRUD, editor de llamadas (`package_id`), stock, destacados, recálculo por margen     |
| **Juegos**        | CRUD, `game_id`/`game_type`, patrón de validación del ID, colores e imágenes         |
| **Usuarios**      | Buscar, ver ficha e historial, cambiar rol, bloquear, ajustar saldo, notificar       |
| **Cupones**       | Porcentaje o monto fijo, mínimos, topes, límites por usuario, vigencia, por juego    |
| **Soporte**       | Consultas de los clientes y cambio de estado                                        |
| **Configuración** | Tasa (manual/automática), datos bancarios, WhatsApp, checkout, márgenes, avisos      |
| **Bitácora**      | Registro de cada acción sensible con autor, fecha e IP (sólo `admin`)                |

Interruptores útiles en Configuración:

- **Modo mantenimiento** — bloquea la creación de órdenes a los clientes; el staff sigue
  pudiendo comprar para probar.
- **Despacho automático** — si lo apagas, los pagos se verifican pero las recargas quedan
  esperando acción manual. Sirve si el proveedor está caído.

## Seguridad

- Credenciales de proveedores en Secret Manager, nunca en el bundle ni en el repositorio.
- Reglas de Firestore con cierre por defecto; el cliente no escribe órdenes ni precios.
- Verificación del ID token en cada petición privada, con `checkRevoked` para que un
  usuario bloqueado pierda el acceso al instante.
- Rate limiting respaldado por Firestore en creación de órdenes, verificación de pagos,
  tickets y rutas de arranque.
- Candado de idempotencia por referencia bancaria.
- Bitácora de auditoría de toda acción con impacto económico o de permisos.
- Cabeceras de seguridad en Hosting y CORS restringido a los orígenes conocidos.

## API

Todas las rutas cuelgan de `/api`. Las privadas esperan
`Authorization: Bearer <ID token de Firebase>`.

**Público**

```
GET  /api/health
GET  /api/config
GET  /api/catalog
GET  /api/games/:gameId
GET  /api/quote?usd=10
```

**Cliente** (requiere sesión)

```
POST /api/orders                  crear orden
POST /api/orders/preview          previsualizar precio con cupón y nivel
POST /api/orders/:id/verify       verificar el pago
POST /api/orders/:id/cancel
GET  /api/orders                  historial
GET  /api/orders/:id              detalle + historial de eventos
GET  /api/me                      perfil, estadísticas y órdenes recientes
PATCH /api/me
GET|POST|DELETE /api/me/player-ids
GET  /api/me/notifications
POST /api/me/notifications/read-all
POST /api/me/referral
GET|POST /api/me/tickets
```

**Panel** (requiere staff; algunas rutas exigen admin)

```
GET  /api/admin/overview?days=30
GET  /api/admin/top-products
GET  /api/admin/orders            · /search · /:id · /export/csv
POST /api/admin/orders/:id/retry  · /complete · /refund · /note
GET|POST|PATCH|DELETE /api/admin/products · /games · /coupons
POST /api/admin/products/reprice  · /api/admin/catalog/seed
GET  /api/admin/users · /:id
POST /api/admin/users/:id/role · /ban · /wallet · /notify
GET|PATCH /api/admin/config
POST /api/admin/config/rate · /rate/auto · /rate/refresh
GET  /api/admin/logs
```

## Desarrollo local

Hacen falta **dos terminales**:

```bash
npm run dev:api    # API en http://127.0.0.1:5051  (emulador de Functions)
npm run dev        # tienda en http://localhost:5173
```

El proxy de Vite manda `/api/**` al emulador, así que no hay que configurar nada más. Si
levantas sólo `npm run dev`, la tienda carga pero el catálogo aparece vacío: falta la API.

Para que el emulador lea los secretos, copia `functions/.secret.local.example` a
`functions/.secret.local` y rellénalo (ese archivo está en `.gitignore`).

### Sin Java

`npm run dev:api` arranca **sólo el emulador de Functions**, que no necesita Java. El
Admin SDK usa entonces las credenciales del Firebase CLI y lee y escribe en el **Firestore
real** del proyecto. Es cómodo, pero ten presente que lo que hagas ahí afecta a los datos
de producción.

Si prefieres una base de datos local y aislada, instala un JDK
(`brew install --cask temurin`) y usa `npm run dev:api:full`, que levanta también los
emuladores de Firestore y Auth.

### Puertos

Los emuladores usan puertos poco comunes a propósito, para no chocar con otros proyectos:

| Servicio  | Puerto |
| --------- | ------ |
| Functions | 5051   |
| Firestore | 8380   |
| Auth      | 9399   |
| Hosting   | 5080   |
| UI        | 4300   |

Si ves `Cannot GET /refill-e254f/us-central1/api/...` en el navegador, hay otro servidor
ocupando el puerto de Functions: ese mensaje es el 404 por defecto de un Express ajeno.
Compruébalo con `lsof -nP -iTCP:5051 -sTCP:LISTEN`.

Comprobaciones:

```bash
npm run typecheck   # tipos de web y functions
npm run build       # build de producción de ambos
npm run lint
```
