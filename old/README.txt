Scraper de beneficios - Banco Provincia de Buenos Aires

Este script accede a la sección de beneficios de bancoprovincia.com.ar
(www.bancoprovincia.com.ar/mvc/beneficios), recorre las categorías listadas
en el índice principal y extrae la información de cada promoción (vigencia,
porcentaje/tipo de beneficio, rubro, condiciones, legales y locales/marcas
adheridas), guardando todo en un único archivo JSON consolidado.

Requisitos
- Node.js instalado (v16 o superior recomendado)
- Ejecutar: `npm install puppeteer`
- La primera vez, Puppeteer necesita descargar su propio Chrome:
  `npx puppeteer browsers install chrome`

Uso
1. `node index.js`
2. El resultado estará en `./data/beneficios_bapro.json`

Cómo funciona (resumen)
1. Entra a la página índice de beneficios y lee los links de categorías
   dentro de `#beneficios_rubros`.
2. Filtra automáticamente los links que apuntan a dominios externos al
   banco (ej. Provincia Compras, Visa, Mastercard) y no los recorre.
3. Para cada categoría interna, navega DIRECTO a su URL con `page.goto()`
   (ya la tenemos disponible al leer el índice, no hace falta simular un
   click) y detecta con qué tipo de estructura de página está tratando
   (ver "Patrones de página" abajo) y extrae la información según
   corresponda.
4. Vuelve al índice (navegando directo a la URL base, no con "atrás" del
   navegador) para continuar con la próxima categoría.
5. Si una categoría falla igual (timeout, estructura no reconocida, etc.),
   el error se registra en consola y en el array `categoriasConError`, y el
   script sigue con la próxima categoría sin perder lo ya acumulado.
6. Al final escribe todo en `./data/beneficios_bapro.json`.

Resultado de la última corrida
- 34 categorías encontradas en el índice principal.
- 2 externas (Provincia Compras, Beneficios VISA) omitidas a propósito.
- 32 categorías internas procesadas (incluyendo sub-rubros de
  Entretenimientos y Hogar y Deco), 0 con error.
- 82 beneficios/promociones guardadas en total en el JSON final, todas
  con datos reales (ya no quedan entradas "vacías").

  Patrones de página identificados
El sitio no usa una sola estructura de HTML para todas las categorías; se
identificaron 4 patrones distintos, y el script los detecta automáticamente
en cada categoría (en este orden):

1. Artículo(s) de promoción (la gran mayoría de las categorías, ej.
   Gastronomía, Indumentaria, Hoteles, etc.): un `.internal_content_area`
   con uno o varios bloques de promo. Cada `<h2 class="benef3">` marca el
   límite entre una promoción y la siguiente (una misma página puede tener
   varias, como Indumentaria con 4). Se extrae título, rubro, porcentaje,
   condiciones y locales/marcas adheridas.
   RESUELTO (en 2 vueltas): al principio este patrón se activaba con solo
   detectar un `<h1>`, lo cual generaba entradas "vacías" para páginas
   "paraguas" sin contenido propio (Entretenimientos, Hogar y Deco).
   Ajustarlo para exigir `h2.benef3` a secas rompió otras 2 categorías
   (Open Sports, especial_indumentaria) que sí tienen contenido real
   (porcentaje, legales) pero sin ningún `benef3`. La versión final exige
   `h1` + AL MENOS UNA de estas 3 señales: `h2.benef3`, `span.porcentajePromo`
   o `p.legales`. Si no encuentra ninguna, la categoría cae a los patrones
   siguientes (CDNI, resultados, sub-rubros) antes de rendirse.

2. Grilla de tarjetas CDNI (categoría "cdni" / Cuenta DNI): tarjetas
   `.callModalCDNI` repetidas, cada una con título, vigencia, rubro (por el
   `alt` del logo) y porcentaje. RESUELTO: además de los datos visibles,
   el script clickea cada una de las 25 tarjetas, espera a que se abra su
   modal de detalle (`#popup`), y extrae de ahí el legal completo
   (`#popupContentLegal p.BEN_MOD_legal`), el tope (`.BEN_MOD_baj`) y las
   condiciones detalladas (`.BEN_MOD_lineas`), antes de cerrar el modal y
   pasar a la próxima tarjeta.
   Excepción conocida: 2 de las 25 tarjetas (temática "localidades"/
   "marcas destacadas") no abren el modal normal, sino que NAVEGAN a otra
   página (parecen requerir elegir una provincia/localidad primero). El
   script detecta ese caso, recupera la navegación de vuelta a la
   categoría, y sigue con la próxima tarjeta sin perder las demás. Esas 2
   tarjetas puntuales quedan con `legales: null`.

3. Listado con `#resultados_beneficios`: patrón contemplado en el
   código (`extraerDeResultadosBeneficios`) pero NUNCA confirmado con un
   HTML real donde ese contenedor tuviera resultados cargados. No se activó
   en ninguna corrida real hasta ahora; los selectores ahí son "mejor
   esfuerzo" sin confirmar.

4. Sub-rubros por ícono (`<img onclick="window.location.href='...'">`):
   confirmado y funcionando para las 2 categorías "paraguas" sin beneficios
   propios: Entretenimientos (Cine, Parques y Paseos, Recitales, Teatro) y
   Hogar y Deco (Bazar/Deco, Colchonería, Mueblerías). El script detecta
   que la categoría no tiene ninguna señal de contenido propio (ver patrón
   1), busca estos íconos, y entra a cada uno recursivamente extrayendo su
   contenido real. El nombre de cada sub-rubro sale del `alt`/`title` de su
   ícono y, si ninguno existe, se deriva del último segmento de su URL.

 Provincia Compras y Beneficios VISA
Quedan intencionalmente afuera del scraping. Provincia Compras es un sitio
de e-commerce aparte (plataforma VTEX, dominio `baproar.vtexassets.com` /
`provinciacompras.com.ar`), y Beneficios VISA lleva a visa.com.ar — ninguno
de los dos forma parte de la sección de "beneficios" propiamente dicha del
banco. Ambos links se detectan y se omiten automáticamente por ser
externos.

 Pendientes / próximas mejoras (no bloqueantes para esta entrega)
1. 2 de las 25 tarjetas de CDNI (temática "localidades"/"marcas
   destacadas") no abren su modal de detalle: navegan a otra página en vez
   de mostrar el popup, probablemente porque requieren elegir una
   provincia/localidad primero. Quedan con `legales: null`. El script
   recupera la navegación automáticamente y sigue con las demás tarjetas
   sin perderlas.
2. Confirmar selectores reales del patrón `#resultados_beneficios` si
   alguna vez se activa en una corrida (por ahora no se disparó nunca).
3. Los textos legales de las categorías con múltiples promos en la misma
   página (patrón 1, ej. Indumentaria) se comparten entre todas las promos
   de esa página, porque suelen estar referenciados por notas al pie
   compartidas (1)(2)(3) entre varias promos; separarlos 1 a 1 requeriría
   parsear esas referencias numéricas.

