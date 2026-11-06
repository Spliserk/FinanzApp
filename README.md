# FinanzApp Web

Versión web de FinanzApp: página HTML + **Firestore**, con sincronización en
tiempo real y modo offline (el mismo patrón del inventario del lab, que sí
sincroniza). No necesita compilarse ni instalarse: se sirve tal cual y se
hostea gratis en GitHub Pages.

## Cómo dejarla funcionando (una sola vez, ~10 min)

### 1. Crear el proyecto de Firebase
1. Entra a <https://console.firebase.google.com> y crea un proyecto (o reutiliza el del inventario).
2. En **Compilación → Authentication** → *Comenzar* → activa **Correo electrónico/contraseña**.
3. En **Compilación → Firestore Database** → *Crear base de datos* → modo producción, región cercana (ej. `us-east1`).

### 2. Pegar las reglas de seguridad
En **Firestore Database → pestaña Reglas**, pega el contenido de [`firestore.rules`](firestore.rules) y publica. Así cada quien solo ve sus propios datos.

### 3. Copiar la configuración
1. ⚙️ **Configuración del proyecto → Tus apps → Web (`</>`)** → registra una app.
2. Copia el objeto `firebaseConfig` y pégalo en [`js/config.js`](js/config.js).

### 4. Probar en local (opcional)
Como usa módulos ES, ábrela con un servidor, no con doble clic:
```bash
cd finanzapp-web
python -m http.server 8080
```
Luego abre <http://localhost:8080>.

### 5. Publicar en GitHub Pages
1. Crea un repo en GitHub y sube esta carpeta.
2. **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. En un par de minutos queda en `https://<usuario>.github.io/<repo>/`.

> Las claves de `firebaseConfig` **no son secretas** (van en el navegador a
> propósito). La seguridad la dan las reglas de Firestore del paso 2.

## Qué incluye esta versión
- Login con correo/contraseña (datos privados por usuario).
- Perfiles (Personal / Negocio).
- Movimientos (ingresos/gastos) con categoría, monto, fecha y nota.
- Tablero: saldo, ingresos/gastos del mes y desglose por categoría.
- Categorías por defecto y personalizables.
- **Inventario** (solo perfiles de Negocio): productos y materiales con stock,
  precio y stock mínimo; reabastecer (con gasto automático opcional), editar y eliminar.
- **Ventas / Pedidos** (negocio modo Ventas): pedidos con varios artículos que
  descuentan stock y registran el ingreso; estados pendiente → en proceso → enviado →
  entregado; cancelar restaura stock y revierte el ingreso.
- **Alquileres / Contratos** (negocio modo Alquiler): apartar → recoger → devolver,
  con pago por cobrar/pagado; las unidades reducen la disponibilidad (no el stock) y
  vuelven al devolver; el ingreso se registra al aprobar el pago.
- El perfil de negocio tiene **modo** (Ventas o Alquiler) que define sus pestañas.
- **Recibos**: desde un pedido o contrato se genera un recibo imprimible
  (el navegador permite "Guardar como PDF") con número, cliente, artículos y total.
- **Analíticas**: gráfico de ingresos vs gastos de los últimos 6 meses en el tablero.
- **Producción libre** (negocio): consumir materiales para producir productos, ajustando
  el stock de cada uno (p. ej. 1 pliego → 3 cajas).
- **Editar movimientos**, recuperar contraseña por correo, y fecha de devolución con
  aviso de "atrasado" en los alquileres.
- **Negocios compartidos**: invita a otra persona por correo para co-gestionar un
  negocio; ambos ven y editan en tiempo real. Cada quien mantiene sus perfiles
  personales privados. (Modelo de datos: perfiles de nivel superior con `members`.)
- **Calendario de eventos** en el inicio: entregas de pedidos, recogidas y devoluciones
  de alquiler, con agenda de próximos eventos y aviso de atrasados.
- **Instalable (PWA)**: se puede "Agregar a la pantalla de inicio" con ícono propio,
  abre a pantalla completa y funciona offline.
- Diseño **Material Design 3** (Roboto, Material Symbols, ripple, bottom sheets).
- Sincronización en tiempo real + offline (indicador de nube arriba a la derecha).
