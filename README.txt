 Scraper de beneficios - Banco Provincia de Buenos Aires

Este script accede a la sección de beneficios de bancoprovincia.com.ar (www.bancoprovincia.com.ar/mvc/beneficios), recorre las categorías listadas en el índice principal y extrae la información de cada promoción (vigencia, porcentaje/tipo de beneficio, rubro, condiciones, legales y locales/marcas adheridas), guardando todo en un único archivo JSON consolidado.

 Requisitos
- Node.js instalado (v16 o superior recomendado)
- Ejecutar: `npm install puppeteer`
- La primera vez, Puppeteer necesita descargar su propio Chrome: `npx puppeteer browsers install chrome`

 Uso
1. `node index.js`
2. El resultado estará en `./data/productos.json`

 Cómo funciona (resumen)
1. Entra a la página índice de beneficios y lee los links de categorías dentro de `#beneficios_rubros`. Usa `waitUntil: 'domcontentloaded'` y no `networkidle2`, porque el widget de chat del sitio mantiene la red activa y `networkidle2` nunca se cumple.
2. Filtra automáticamente los links que apuntan a dominios externos al banco (ej. Provincia Compras, Visa, Mastercard) y no los recorre.
3. Para cada categoría interna, navega DIRECTO a su URL con `page.goto()` (ya la tenemos disponible al leer el índice, no hace falta simular un click) y detecta con qué tipo de estructura de página está tratando (ver "Patrones de página" abajo) y extrae la información según corresponda.
4. Vuelve al índice (navegando directo a la URL base, no con "atrás" del navegador) para continuar con la próxima categoría.
5. Toda navegación pasa por `navegarConReintentos`: hasta 3 intentos con espera creciente entre uno y otro, para no perder una categoría por un fallo transitorio (timeouts, avisos SSL, etc.).
6. Si la pestaña queda inutilizable (error "detached Frame", pestaña o sesión cerrada), el script abre una pestaña nueva, vuelve al índice y repite esa categoría UNA sola vez, descartando lo que hubiera alcanzado a guardar de ella para no duplicar datos.
7. Si el sitio responde con su propia página de error (“Página no Disponible”), es decir, un enlace roto en el índice del banco, se informa en el log y se sigue con la próxima categoría. No se cuenta como error ni se reintenta.
8. Si una categoría falla por una excepción (timeout de red, etc.), el error se registra en categoriasConError y el script sigue con la próxima sin perder lo ya acumulado. Los datos parciales de esa categoría se descartan para no duplicarlos en el reintento. Las categorías con estructura no reconocida también se registran, pero no se reintentan, porque volver a cargarlas no cambia el resultado.
9. Segunda pasada: al terminar el recorrido, cada categoría que falló por una excepción se reintenta una sola vez. Si se recupera, se quita de los errores; si vuelve a fallar, queda registrada con ambos mensajes.
10. Al final escribe todo en ./data/productos.json e informa en consola el total de beneficios guardados, cuántas categorías se recuperaron en la segunda pasada y el detalle de las que quedaron con error, si las hubo.

 Resultado de la última corrida (10/11/2026)
- 38 categorías encontradas en el índice principal.
- 3 externas (Provincia Compras, Mastercard, Beneficios VISA) omitidas a propósito.
- 35 categorías internas recorridas, 0 con error. Dos de ellas son categorías “paraguas” (Entretenimientos y Hogar y Deco), que se resolvieron entrando a sus 7 sub-rubros (4 y 3 respectivamente).
- 79 beneficios/promociones guardadas en total en el JSON final.
1 de esas categorías (“Adelantate verano”) es una landing de campaña sin promociones propias: enlaza a Automotores, Ómnibus, Hoteles y Balnearios, que ya se procesan por separado (ver patrón 5).
- La grilla de CDNI tuvo 21 tarjetas en esta corrida (2 de ellas sin legal, ver patrón 2).
- No hubo categorías para reintentar en la segunda pasada ni enlaces rotos en el índice.

 Cambios respecto a la entrega anterior (corrida del 02/11: 39 categorías, 79 beneficios) El sitio actualiza sus promociones periódicamente, así que es normal que las categorías y los beneficios varíen entre corridas: 
- El índice pasó de 38 a 39 categorías, y los beneficios de 80 a 79.
- Categoría que ya no aparece: "icono_rubro_seven" (tenía 1 promoción).
- Categorías nuevas: "Decathlon" (1 promoción, procesada con el patrón 1 sin ajustes) y "Aerolíneas Argentinas", cuyo enlace en el índice está roto (el sitio responde "Página no Disponible"), por lo que no aporta beneficios.
- La grilla de CDNI pasó de 22 a 21 tarjetas.
- Se agregó una segunda pasada que reintenta una vez las categorías que fallaron por una excepción (por ejemplo, timeouts de red).
- Se agregó la detección de enlaces rotos del índice, que se informan en el log y no se cuentan como error.
- Al registrar un error, el resumen final lista cada categoría afectada.

 Patrones de página identificados
El sitio no usa una sola estructura de HTML para todas las categorías; se identificaron 5 patrones distintos, y el script los detecta automáticamente en cada categoría, en este orden: artículo(s), grilla CDNI, listado de resultados, sub-rubros y landing de campaña.

1. Artículo(s) de promoción (la gran mayoría de las categorías, ej. Gastronomía, Indumentaria, Hoteles, etc.): un `.internal_content_area` con uno o varios bloques de promo. Cada `<h2 class="benef3">` marca el límite entre una promoción y la siguiente (una misma página puede tener varias, como Indumentaria con 4). Se recorre el contenido en orden de documento con un TreeWalker y se extrae título, rubro, porcentaje, condiciones y locales/marcas adheridas.
   Criterio de detección: `h1` + AL MENOS UNA de estas 3 señales: `h2.benef3`, `span.porcentajePromo` o `p.legales`. Exigir solo el `h1` generaba entradas vacías para páginas "paraguas" sin contenido propio (Entretenimientos, Hogar y Deco), y exigir solo `h2.benef3` dejaba afuera categorías con contenido real pero sin ese elemento (Open Sports, especial_indumentaria). Si no encuentra ninguna señal, la categoría cae a los patrones siguientes antes de rendirse.

2. Grilla de tarjetas CDNI (categoría "cdni" / Cuenta DNI): tarjetas `.callModalCDNI` repetidas, cada una con título, vigencia, rubro (por el `alt` del logo) y porcentaje. Además de los datos visibles, el script clickea cada tarjeta, espera a que se abra su modal de detalle (`#popup`) y extrae de ahí el legal completo (`#popupContentLegal p.BEN_MOD_legal`), el tope (`.BEN_MOD_baj`) y las condiciones detalladas (`.BEN_MOD_lineas`), antes de cerrar el modal y pasar a la próxima tarjeta.
   Si el modal no se muestra a tiempo, se reintenta el click una vez; si sigue sin mostrarse, se omite el legal de esa tarjeta (no se lee `#popup`, para no asignarle el contenido de la tarjeta anterior). Una falla puntual en una tarjeta no afecta a las demás.
   Excepción conocida: 2 tarjetas ("localidades" y "marcas destacadas") no abren el modal normal, sino que NAVEGAN a otra página (parecen requerir elegir una provincia/localidad primero). El script detecta ese caso, recupera la navegación de vuelta a la categoría y sigue con la próxima tarjeta sin perder las demás. Esas 2 tarjetas quedan con `legales: null`.

3. Listado con `#resultados_beneficios`: patrón contemplado en el código (`extraerDeResultadosBeneficios`) pero NUNCA confirmado con un HTML real donde ese contenedor tuviera resultados cargados. No se activó en ninguna corrida real hasta ahora; los selectores ahí son "mejor esfuerzo" sin confirmar.

4. Sub-rubros por ícono (`<img onclick="window.location.href='...'">`): confirmado y funcionando para las 2 categorías "paraguas" sin beneficios propios: Entretenimientos (Cine, Parques y Paseos, Recitales, Teatro) y Hogar y Deco (Bazar/Deco, Colchonería, Mueblerías). El script detecta que la categoría no tiene ninguna señal de contenido propio (ver patrón 1), busca estos íconos y entra a cada uno de forma recursiva (con un límite de profundidad para evitar ciclos). El nombre de cada sub-rubro sale del `alt`/`title` de su ícono y, si ninguno existe, se deriva del último segmento de su URL.

5. Landing de campaña (ej. "Adelantate verano"): página con un título y una fila de íconos que enlazan a otras categorías del sitio, sin promociones propias. Como las categorías enlazadas ya se recorren desde el índice principal, no se extrae nada de la landing para no duplicar datos, y se registra como mensaje informativo (no como error).

 Provincia Compras y Beneficios VISA
Quedan intencionalmente afuera del scraping. Provincia Compras es un sitio de e-commerce aparte (plataforma VTEX, dominio `baproar.vtexassets.com` / `provinciacompras.com.ar`), y Beneficios VISA lleva a visa.com.ar. Ninguno de los dos forma parte de la sección de "beneficios" propiamente dicha del banco. Ambos links, igual que el de Mastercard, se detectan y se omiten automáticamente por ser externos.

 Pendientes / próximas mejoras (no bloqueantes para esta entrega)
1. Confirmar selectores reales del patrón `#resultados_beneficios` si alguna vez se activa en una corrida (por ahora no se disparó nunca).
2. Los textos legales de las categorías con múltiples promos en la misma página (patrón 1, ej. Indumentaria) se comparten entre todas las promos de esa página, porque suelen estar referenciados por notas al pie compartidas (1)(2)(3) entre varias promos; separarlos 1 a 1 requeriría parsear esas referencias numéricas.
