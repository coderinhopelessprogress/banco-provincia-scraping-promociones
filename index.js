/**
 * ============================================================
 *  Scraper de Beneficios - Banco Provincia de Buenos Aires
 * ============================================================
 *
 *  Estrategia: recorrido secuencial por categorías con navegación directa.
 *
 *  1) Entramos a la página principal de beneficios.
 *  2) Leemos el listado de categorías dentro de #beneficios_rubros y
 *     descartamos los enlaces externos al banco.
 *  3) Para cada categoría interna navegamos directo a su URL con
 *     page.goto(), detectamos qué patrón de página es (artículo, grilla
 *     CDNI, listado, sub-rubros o landing de campaña) y extraemos sus
 *     beneficios.
 *  4) Volvemos al índice con page.goto(BASE_URL) y repetimos con la
 *     siguiente categoría.
 *  5) Guardamos todo en un único array consolidado -> data/productos.json.
 *
 *  Requisitos previos:
 *    npm init -y
 *    npm install puppeteer
 *
 *  Ejecución:
 *    node index.js
 * ============================================================
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// -----------------------------
// Configuración general
// -----------------------------
const BASE_URL = 'https://www.bancoprovincia.com.ar/mvc/beneficios';
const BANK_HOSTNAME = 'www.bancoprovincia.com.ar'; // dominio "interno" válido
const OUTPUT_DIR = './data';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'productos.json');

const NAV_TIMEOUT = 30000; // 30s para navegaciones
const SELECTOR_TIMEOUT = 15000; // 15s para esperar selectores

/**
 * Indica si un error significa que la pestaña de Puppeteer quedó
 * inutilizable (frame desprendido, pestaña o sesión cerrada). En ese estado
 * reintentar sobre la misma pestaña no sirve: hay que abrir una nueva.
 */
function esErrorDePaginaInutilizable(error) {
  return /detached|Target closed|Session closed/i.test((error && error.message) || '');
}

/**
 * Cierra la pestaña anterior (sin bloquearse si ya está rota) y abre una
 * nueva con los mismos timeouts por defecto.
 */
async function abrirPaginaNueva(browser, paginaVieja) {
  try {
    await Promise.race([paginaVieja.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch {
    // la pestaña ya estaba cerrada o inutilizable
  }
  const pagina = await browser.newPage();
  pagina.setDefaultNavigationTimeout(NAV_TIMEOUT);
  pagina.setDefaultTimeout(SELECTOR_TIMEOUT);
  return pagina;
}

/**
 * Navega a una URL con reintentos. El sitio a veces responde lento y una
 * navegación puntual puede superar el timeout; en lugar de perder la
 * categoría completa por un fallo transitorio, se reintenta con una espera
 * creciente entre intentos y recién después se propaga el error.
 */
async function navegarConReintentos(page, url, intentos = 3) {
  let ultimoError;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      return;
    } catch (error) {
      ultimoError = error;
      // Con la pestaña inutilizable, reintentar sobre ella no sirve: se
      // propaga enseguida para que el llamador abra una pestaña nueva.
      if (esErrorDePaginaInutilizable(error)) throw error;
      console.warn(
        `   ⚠️  Navegación a ${url} falló (intento ${intento}/${intentos}): ${error.message}`
      );
      if (intento < intentos) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * intento));
      }
    }
  }
  throw ultimoError;
}

/**
 * Determina si un href apunta a un dominio externo al banco.
 * Devuelve true si el link es EXTERNO (y por lo tanto debe omitirse).
 */
function esLinkExterno(href) {
  if (!href) return true; // sin href -> lo tratamos como no navegable

  try {
    const url = new URL(href, BASE_URL); // resuelve relativos contra la base

    // Si el protocolo no es http/https (ej: mailto:, tel:, javascript:) lo consideramos externo/no navegable
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

    // Lista de fragmentos de dominios de terceros conocidos (se puede ampliar)
    const dominiosExternosConocidos = [
      'provincianet',
      'provinciacompras.com.ar',
      'visa.com',
      'mastercard.com',
      'provinciaseguros',
      'grupobapro',
    ];

    const hostname = url.hostname.toLowerCase();

    const coincideConocido = dominiosExternosConocidos.some((frag) =>
      hostname.includes(frag)
    );
    if (coincideConocido) return true;

    // Si el hostname no coincide con el dominio del banco, lo tratamos como externo
    if (hostname !== BANK_HOSTNAME) return true;

    return false;
  } catch (err) {
    // Si la URL no se pudo parsear, la tratamos como no navegable / externa
    return true;
  }
}

/**
 * Extrae TODAS las promociones dentro de una página de categoría ya cargada.
 *
 * Confirmado con HTML real de dos categorías distintas:
 *   - Gastronomía: 1 sola promoción en la página.
 *   - Indumentaria: 4 promociones distintas apiladas en la MISMA página
 *     (10%+4 cuotas / 12 cuotas sin interés / 6 cuotas online / Nike 12 cuotas fijas).
 *
 * El límite real entre una promo y la siguiente NO es <div class="dividerBenef">
 * (eso marca campañas más grandes, ej. "Todos los viernes y sábados" vs
 * "Todos los días", que pueden contener varias promos adentro), sino cada
 * aparición de <h2 class="benef3"> (el rubro/alcance de esa promo puntual,
 * ej. "En indumentaria", "En toda la tienda").
 *
 * Estrategia: recorremos todo el árbol de `.internal_content_area` en orden
 * de documento con un TreeWalker, generamos una lista plana de "eventos"
 * (h1, porcentaje, benef3, condición, local adherido, legal) y después
 * agrupamos: cada `benef3` cierra/abre una promo nueva, absorbiendo los
 * porcentajes vistos desde la promo anterior y las condiciones/locales que
 * aparecen HASTA la próxima benef3.
 *
 * Los legales (letra chica) se recolectan a nivel de página completa (no
 * por promo individual), porque suelen estar referenciados por números de
 * nota al pie -> (1), (2), (3) -> compartidos entre varias promos, y
 * separarlos 1 a 1 requeriría parsear esas referencias (no vale la pena
 * la complejidad extra por ahora). Se adjunta el mismo bloque de legales
 * a cada promoción de la página.
 */
async function extraerPromocionesDeCategoria(page, categoriaNombre) {
  await page.waitForSelector('.internal_content_area', { timeout: SELECTOR_TIMEOUT });

  const promociones = await page.evaluate((categoria) => {
    const root = document.querySelector('.internal_content_area');
    if (!root) return [];

    // Recorremos TODOS los elementos descendientes en orden de documento,
    // sin importar cuán anidados estén (algunas promos vienen envueltas en
    // <div class="spacer"> extra, otras no).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const eventos = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.matches('h1')) {
        eventos.push({ tipo: 'h1', texto: node.innerText.trim() });
      } else if (node.matches('span.porcentajePromo')) {
        eventos.push({ tipo: 'porcentaje', texto: node.innerText.trim() });
      } else if (node.matches('h2.benef3')) {
        eventos.push({ tipo: 'benef3', texto: node.innerText.trim() });
      } else if (node.matches('p.spacer')) {
        eventos.push({ tipo: 'condicion', texto: node.innerText.trim() });
      } else if (node.matches('a.obj_editor-link-text')) {
        eventos.push({
          tipo: 'local',
          nombre: node.querySelector('img')?.getAttribute('alt') || null,
          logo: node.querySelector('img')?.src || null, // URL completa de la imagen
          url: node.href || null,
        });
      } else if (node.matches('p.legales')) {
        eventos.push({ tipo: 'legal', texto: node.innerText.trim() });
      }
      // Nota: <div class="dividerBenef"> NO se usa como límite de promo
      // (ver comentario arriba), así que no generamos evento para él.
    }

    const promos = [];
    const legales = [];
    let promoActual = null;
    let tituloVigente = null;
    let porcentajesPendientes = [];

    for (const ev of eventos) {
      if (ev.tipo === 'h1') {
        tituloVigente = ev.texto || tituloVigente; // ignoramos h1 vacíos decorativos
      } else if (ev.tipo === 'porcentaje') {
        if (ev.texto) porcentajesPendientes.push(ev.texto);
      } else if (ev.tipo === 'benef3') {
        promoActual = {
          categoria,
          titulo: tituloVigente,
          rubro: ev.texto || null,
          // dedupe: el HTML a veces anida el mismo span dos veces (mismo valor)
          porcentaje: [...new Set(porcentajesPendientes)].join(' + ') || null,
          condiciones: [],
          locales_adheridos: [],
        };
        porcentajesPendientes = [];
        promos.push(promoActual);
      } else if (ev.tipo === 'condicion') {
        if (promoActual && ev.texto) promoActual.condiciones.push(ev.texto);
      } else if (ev.tipo === 'local') {
        if (promoActual) {
          promoActual.locales_adheridos.push({
            nombre: ev.nombre,
            logo: ev.logo,
            url: ev.url,
          });
        }
      } else if (ev.tipo === 'legal') {
        if (ev.texto) legales.push(ev.texto);
      }
    }

    // Fallback: si la página no tiene ningún h2.benef3 (estructura mínima o
    // distinta a lo visto hasta ahora), igual devolvemos UNA promoción
    // "genérica" con lo que se haya podido juntar, para no perder la
    // categoría entera por no encajar 100% en el patrón esperado.
    if (promos.length === 0) {
      promos.push({
        categoria,
        titulo: tituloVigente,
        rubro: null,
        porcentaje: [...new Set(porcentajesPendientes)].join(' + ') || null,
        condiciones: [],
        locales_adheridos: [],
      });
    }

    const legalesTexto = legales.join(' ') || null;

    return promos.map((p) => ({
      ...p,
      condiciones: p.condiciones.join(' | ') || null,
      legales: legalesTexto,
    }));
  }, categoriaNombre);

  return promociones;
}

/**
 * Extrae tarjetas de beneficios del patrón "CDNI" (Cuenta DNI).
 *
 * Confirmado con HTML real de la categoría "cdni". Cada tarjeta:
 *
 *   <a>
 *     <div class="callModalCDNI BEN_filterDiv vari dest" id="beneficio_librerias-561">
 *       <div class="tituloBeneficio">Renová tu biblioteca con esta promo</div>
 *       <div class="BEN_CON_dias">Lunes y martes</div>
 *       <div class="BEN_CON_content">
 *         <img class="logo_recuadro" src="/CDN/Get/librerias_pictograma" alt="librerias_pictograma">
 *         <div class="BEN_CON_nro">10</div>
 *         <div class="BEN_CON_porcien">%</div>
 *         <div class="BEN_CON_ahorro">de ahorro</div>
 *       </div>
 *       <div class="BEN_CON_legal">Conocé más</div>  <- NO es el legal real, es el texto del botón
 *     </div>
 *   </a>
 *
 * El legal completo NO está en esta tarjeta: se carga recién al hacer click,
 * que abre un modal vía JS. Confirmado con HTML real del modal ABIERTO:
 *
 *   <div id="popup" class="modal" style="display: flex;">
 *     <div class="modal-content" ...>
 *       <span class="close">×</span>
 *       <div id="popupContentTitular">...</div>
 *       <div id="popupContent">
 *         ...
 *         <p class="BEN_MOD_baj">Tope de reintegro...</p>
 *         <div class="BEN_MOD_lineas">Línea de condición 1</div>
 *         <div class="BEN_MOD_lineas">Línea de condición 2</div>
 *       </div>
 *       <div id="popupContentLegal">
 *         <p class="BEN_MOD_legal">TEXTO LEGAL COMPLETO...</p>
 *       </div>
 *     </div>
 *   </div>
 *
 * Estrategia: primero sacamos todo lo visible sin interactuar (título,
 * vigencia, rubro, porcentaje, id) con un solo $$eval. Después, POR CADA
 * tarjeta, la clickeamos, esperamos a que #popup se muestre, extraemos el
 * legal/tope/condiciones detalladas de adentro, cerramos el modal con
 * #popup .close, y esperamos a que se oculte antes de pasar a la próxima
 * (evita que dos modals se pisen si el cierre es animado).
 */
async function extraerTarjetasCDNI(page, categoriaNombre) {
  // --- Fase 1: datos visibles sin interactuar ---
  const beneficios = await page.$$eval(
    '.callModalCDNI',
    (tarjetas, categoria) => {
      return tarjetas.map((tarjeta) => {
        // El porcentaje viene partido en dos elementos separados (ej: "10" y "%")
        const nro = tarjeta.querySelector('.BEN_CON_nro')?.innerText.trim() || '';
        const signo = tarjeta.querySelector('.BEN_CON_porcien')?.innerText.trim() || '';
        const ahorro = tarjeta.querySelector('.BEN_CON_ahorro')?.innerText.trim() || '';
        const porcentaje = nro || signo ? `${nro}${signo}${ahorro ? ' ' + ahorro : ''}`.trim() : null;

        return {
          categoria,
          id: tarjeta.getAttribute('id') || null,
          titulo: tarjeta.querySelector('.tituloBeneficio')?.innerText.trim() || null,
          vigencia: tarjeta.querySelector('.BEN_CON_dias')?.innerText.trim() || null,
          rubro: tarjeta.querySelector('.logo_recuadro')?.getAttribute('alt') || null,
          imagen: tarjeta.querySelector('.logo_recuadro')?.src || null,
          porcentaje: porcentaje || null,
          legales: null, // se completa en la Fase 2, abajo
          tope: null,
          condiciones_detalladas: [],
        };
      });
    },
    categoriaNombre
  );

  // --- Fase 2: abrir el modal de cada tarjeta y sacar el legal completo ---
  const totalTarjetas = beneficios.length;

  // Guardamos la URL de la categoría ANTES de empezar a clickear tarjetas.
  // Algunas tarjetas (las temáticas de "localidades" y "marcas") no abren el
  // modal normal sino que NAVEGAN a otra página (parece relacionado con un
  // selector de provincia/localidad). Si eso pasa, .callModalCDNI deja de
  // existir en la página y las tarjetas siguientes fallarían en cadena. Por
  // eso se chequea la URL después de cada click y, si cambió, se vuelve acá
  // antes de seguir con la próxima tarjeta.
  const urlCategoriaCDNI = page.url();

  // Margen para que terminen de cargar los scripts de la página (los
  // handlers de click de las tarjetas se enlazan al cargar). Best-effort.
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

  for (let i = 0; i < totalTarjetas; i++) {
    try {
      // Re-buscamos las tarjetas frescas en cada vuelta (mismo criterio que
      // usamos en el resto del script: evitar ElementHandles obsoletos).
      const tarjetasHandles = await page.$$('.callModalCDNI');
      const tarjetaHandle = tarjetasHandles[i];

      if (!tarjetaHandle) {
        console.warn(
          `   ⚠️  No se encontró la tarjeta CDNI en el índice ${i} (la página pudo haber navegado a otro lado por una tarjeta anterior). Intentando recuperar la navegación...`
        );
        if (page.url() !== urlCategoriaCDNI) {
          await page
            .goto(urlCategoriaCDNI, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
            .catch(() => {});
        }
        continue;
      }

      // Abrimos el modal. Si no aparece a tiempo (sitio lento, o handler de
      // click todavía no enlazado), reintentamos el click una vez antes de
      // rendirnos con esta tarjeta.
      let modalVisible = false;
      for (let intentoModal = 1; intentoModal <= 2 && !modalVisible; intentoModal++) {
        const handleActual =
          intentoModal === 1 ? tarjetaHandle : (await page.$$('.callModalCDNI'))[i];
        if (!handleActual) break;

        await handleActual.click();

        // Esperamos a que el modal quede visible (display !== 'none').
        modalVisible = await page
          .waitForFunction(
            () => {
              const popup = document.querySelector('#popup');
              return !!popup && getComputedStyle(popup).display !== 'none';
            },
            { timeout: 8000 }
          )
          .then(() => true)
          .catch(() => false);

        // Si el click navegó fuera de la categoría, no tiene sentido reintentar.
        if (page.url() !== urlCategoriaCDNI) break;
      }

      // Si el click nos sacó de la página de la categoría (en vez de abrir
      // el modal), no tiene sentido tratar de leer #popup: recuperamos la
      // navegación y seguimos con la próxima tarjeta.
      if (page.url() !== urlCategoriaCDNI) {
        console.warn(
          `   ⚠️  La tarjeta ${i} ("${beneficios[i].titulo}") navegó fuera de la categoría en vez de abrir un modal (probablemente requiere elegir una ubicación). Se omite su legal y se recupera la navegación.`
        );
        await navegarConReintentos(page, urlCategoriaCDNI).catch(() => {});
        continue;
      }

      // Si el modal no se mostró, no se lee #popup: podría contener el
      // contenido de la tarjeta anterior y se le asignaría un legal ajeno.
      if (!modalVisible) {
        console.warn(
          `   ⚠️  El modal no se mostró para la tarjeta ${i} ("${beneficios[i].titulo}") tras 2 intentos. Se omite el legal de esta tarjeta.`
        );
        await page.evaluate(() => {
          document.querySelector('#popup .close')?.click();
        });
        continue;
      }

      // Extraemos legal + tope + condiciones detalladas de adentro del modal.
      const detalle = await page.evaluate(() => {
        const legal = Array.from(
          document.querySelectorAll('#popupContentLegal p.BEN_MOD_legal')
        )
          .map((p) => p.innerText.trim())
          .filter(Boolean)
          .join(' ');

        const tope = document.querySelector('#popupContent .BEN_MOD_baj')?.innerText.trim() || null;

        const condicionesDetalladas = Array.from(
          document.querySelectorAll('#popupContent .BEN_MOD_lineas')
        )
          .map((div) => div.innerText.trim())
          .filter(Boolean);

        return { legal: legal || null, tope, condicionesDetalladas };
      });

      beneficios[i].legales = detalle.legal;
      beneficios[i].tope = detalle.tope;
      beneficios[i].condiciones_detalladas = detalle.condicionesDetalladas;

      // Cerramos el modal antes de pasar a la próxima tarjeta.
      await page.evaluate(() => {
        document.querySelector('#popup .close')?.click();
      });

      // Esperamos a que se termine de ocultar (por si el cierre es animado).
      await page
        .waitForFunction(
          () => {
            const popup = document.querySelector('#popup');
            return !popup || getComputedStyle(popup).display === 'none';
          },
          { timeout: 5000 }
        )
        .catch(() => {});
    } catch (errorModal) {
      // Si una tarjeta puntual falla, se registra y se sigue con las demás
      // para no perder el resto de la grilla.
      console.warn(
        `   ⚠️  Error abriendo el modal de la tarjeta ${i} en "${categoriaNombre}": ${errorModal.message}`
      );

      // Por si el error dejó la página en otra URL (mismo caso de las
      // tarjetas que navegan en vez de abrir un modal), recuperamos antes
      // de que la próxima vuelta intente buscar tarjetas que ya no están.
      if (page.url() !== urlCategoriaCDNI) {
        await page
          .goto(urlCategoriaCDNI, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
          .catch(() => {});
      }
    }
  }

  return beneficios;
}

/**
 * Detecta "sub-rubros" expresados como íconos <img onclick="window.location.href='...'">,
 * un patrón distinto al de #beneficios_rubros a (con <a href>).
 *
 * Confirmado en la categoría "Entretenimientos" (idRubro=322): esa página
 * NO tiene beneficios propios, es un rubro "paraguas" que agrupa 4 sub-rubros
 * (Cine, Parques y Paseos, Recitales, Teatro), cada uno representado por un
 * <img> con un onclick, no por un <a>:
 *
 *   <img src="/CDN/Get/icono_cine" onclick="window.location.href='/mvc/banca-personal/cines'" alt="cine">
 *
 * Devuelve un array de { nombre, url } o [] si no encuentra este patrón.
 */
async function extraerSubIconos(page, baseUrl) {
  const subIconosRaw = await page.$$eval('img[onclick*="window.location.href"]', (imgs) =>
    imgs.map((img) => ({
      // Fallbacks en orden: alt de la imagen -> title de la imagen -> ''
      // (si ninguno existe, más abajo derivamos el nombre de la URL misma,
      // que siempre está disponible, en vez de dejar "sin-nombre").
      nombre: img.getAttribute('alt') || img.getAttribute('title') || '',
      onclick: img.getAttribute('onclick') || '',
    }))
  );

  // Extraemos la URL de adentro del string del onclick con una regex,
  // ya que no es un atributo href navegable directamente.
  const regexUrl = /window\.location\.href\s*=\s*'([^']+)'/;

  return subIconosRaw
    .map(({ nombre, onclick }) => {
      const match = onclick.match(regexUrl);
      if (!match) return null;
      try {
        const urlAbsoluta = new URL(match[1], baseUrl).href;

        // Si no conseguimos nombre por alt/title, lo derivamos del último
        // segmento de la URL (ej: ".../banca-personal/cines" -> "cines").
        // Es mejor que un genérico "sin-nombre" y siempre está disponible.
        const nombreFinal =
          nombre ||
          decodeURIComponent(urlAbsoluta.replace(/\/$/, '').split('/').pop() || '') ||
          'sin-nombre';

        return { nombre: nombreFinal, url: urlAbsoluta };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Verifica si #resultados_beneficios existe en la página y si tiene
 * contenido real (no solo espacios en blanco).
 */
async function tieneResultadosBeneficios(page) {
  const contenedor = await page.$('#resultados_beneficios');
  if (!contenedor) return false;

  const texto = await page.$eval('#resultados_beneficios', (el) => el.innerText.trim());
  return texto.length > 0;
}

/**
 * Extrae tarjetas de comercios desde #resultados_beneficios, para las
 * categorías donde ese contenedor sí tiene contenido cargado (a diferencia
 * de las categorías "paraguas" sin beneficios propios, ver patrón 4).
 *
 * ⚠️ Sin confirmar contra HTML real con este contenedor poblado. Los
 * selectores de abajo son un punto de partida razonable (el sitio usa
 * clases con prefijo "w3-" del framework W3.CSS en el resto de la página),
 * pero conviene revisar el JSON resultante con cuidado si este patrón
 * llega a activarse en una corrida real.
 */
async function extraerDeResultadosBeneficios(page, categoriaNombre) {
  const beneficios = await page.$$eval(
    '#resultados_beneficios .w3-card, #resultados_beneficios .beneficio-item, #resultados_beneficios tr',
    (items, categoria) => {
      return items.map((item) => ({
        categoria,
        comercio: item.querySelector('.titulo, .nombre, td:nth-child(1)')?.innerText.trim() ?? null,
        direccion: item.querySelector('.direccion, .domicilio')?.innerText.trim() ?? null,
        descuento: item.querySelector('.descuento, .porcentaje')?.innerText.trim() ?? null,
        condiciones: item.querySelector('.condiciones')?.innerText.trim() ?? null,
        imagen: item.querySelector('img')?.src ?? null,
        url: item.querySelector('a')?.href ?? null,
      }));
    },
    categoriaNombre
  );

  return beneficios;
}

/**
 * Procesa una categoría de forma RECURSIVA, probando los patrones en orden:
 *   1) Artículo(s): .internal_content_area con h1 y alguna señal de contenido
 *      (h2.benef3, span.porcentajePromo o p.legales) -> extrae y termina.
 *   2) Grilla CDNI (.callModalCDNI) -> extrae cada tarjeta y el legal de su modal.
 *   3) #resultados_beneficios con contenido -> extrae de ahí.
 *   4) Sub-íconos (onclick) -> entra a cada uno y se llama a sí misma.
 *   5) Landing de campaña (h1 + enlaces a otras categorías) -> se registra
 *      como informativa y no se extrae nada.
 *   Si no coincide con ninguno, se registra como estructura desconocida.
 * `profundidad` evita loops infinitos por si dos categorías se referencian
 * circularmente entre sí (no debería pasar, pero es una salvaguarda barata).
 */
async function procesarCategoria(
  page,
  categoriaNombre,
  urlCategoria,
  todosLosBeneficios,
  categoriasConError,
  profundidad = 0
) {
  const MAX_PROFUNDIDAD = 3;

  if (profundidad > MAX_PROFUNDIDAD) {
    console.warn(
      `⚠️  Profundidad máxima alcanzada en "${categoriaNombre}" (${urlCategoria}). Se omite para evitar loops.`
    );
    return;
  }

  const sangria = '  '.repeat(profundidad);

  // El bucle principal ya navegó a la URL de la categoría, así que en la
  // primera llamada no se vuelve a navegar; en una recursión hacia un
  // sub-ícono la URL es distinta y sí se navega explícitamente.
  if (page.url() !== urlCategoria) {
    // Se usa domcontentloaded en vez de networkidle2: el widget de chat en
    // vivo del sitio mantiene conexiones de fondo (polling/websocket) y la
    // red nunca queda "quieta". El waitForSelector de más abajo es la señal
    // real de que cargó el contenido que nos importa.
    await navegarConReintentos(page, urlCategoria);
  }

  // Margen para que el contenido termine de renderizarse (algunas categorías
  // navegan vía SPA/JS y tardan más en mostrarlo). Se espera a que aparezca
  // CUALQUIERA de los selectores de los patrones conocidos; si a los 8s no
  // apareció ninguno, se sigue igual y la categoría se marca más abajo como
  // "estructura no reconocida" (evita un falso negativo por timing).
  await page
    .waitForSelector(
      '.internal_content_area h1, .callModalCDNI, #resultados_beneficios, img[onclick*="window.location.href"]',
      { timeout: 8000 }
    )
    .catch(() => {});

  // --- Patrón 1: página de "artículo(s)" (Gastronomía = 1 promo, Indumentaria = varias) ---
  //
  // No alcanza con detectar un <h1> dentro de .internal_content_area: hay
  // páginas "paraguas" sin beneficios propios (ver patrón 4 más abajo) que
  // también tienen h1 pero ningún contenido real. Tampoco alcanza con
  // exigir puntualmente h2.benef3, porque algunas categorías tienen
  // contenido real (porcentaje, legales) sin ese elemento. Por eso se
  // acepta cualquiera de las 3 señales de contenido (benef3, porcentaje o
  // legales); solo si ninguna está presente, la categoría cae a los
  // patrones siguientes.
  const tieneH1 = (await page.$('.internal_content_area h1')) !== null;
  const tieneSenialDeContenido =
    (await page.$(
      '.internal_content_area h2.benef3, .internal_content_area span.porcentajePromo, .internal_content_area p.legales'
    )) !== null;
  const esArticulo = tieneH1 && tieneSenialDeContenido;
  if (esArticulo) {
    const promociones = await extraerPromocionesDeCategoria(page, categoriaNombre);
    console.log(
      `${sangria}✅ [artículo] "${categoriaNombre}": ${promociones.length} promoción(es) extraída(s)`
    );
    todosLosBeneficios.push(...promociones);
    return;
  }

  // --- Patrón 2: grilla de tarjetas CDNI (confirmado con HTML real de "cdni") ---
  const esGrillaCDNI = (await page.$('.callModalCDNI')) !== null;
  if (esGrillaCDNI) {
    const beneficios = await extraerTarjetasCDNI(page, categoriaNombre);
    console.log(
      `${sangria}✅ [grilla CDNI] "${categoriaNombre}": ${beneficios.length} beneficios extraídos (legal completo por tarjeta, vía modal)`
    );
    todosLosBeneficios.push(...beneficios);
    return;
  }

  // --- Patrón 3: listado con resultados ya cargados ---
  const hayResultados = await tieneResultadosBeneficios(page);
  if (hayResultados) {
    const beneficios = await extraerDeResultadosBeneficios(page, categoriaNombre);
    console.log(
      `${sangria}✅ [listado] "${categoriaNombre}": ${beneficios.length} beneficios extraídos`
    );
    todosLosBeneficios.push(...beneficios);
    return;
  }

  // --- Patrón 4: sin contenido propio, pero con sub-rubros (Entretenimientos) ---
  const subIconos = await extraerSubIconos(page, urlCategoria);
  if (subIconos.length > 0) {
    console.log(
      `${sangria}↳ "${categoriaNombre}" no tiene beneficios propios, tiene ${subIconos.length} sub-rubros. Entrando a cada uno...`
    );

    for (const subIcono of subIconos) {
      try {
        await procesarCategoria(
          page,
          `${categoriaNombre} > ${subIcono.nombre}`,
          subIcono.url,
          todosLosBeneficios,
          categoriasConError,
          profundidad + 1
        );
      } catch (errorSub) {
        console.error(
          `${sangria}❌ Error en sub-rubro "${subIcono.nombre}" de "${categoriaNombre}": ${errorSub.message}`
        );
        categoriasConError.push({
          categoria: `${categoriaNombre} > ${subIcono.nombre}`,
          error: errorSub.message,
        });
      }
    }
    return;
  }

  // --- Patrón 5: landing de campaña sin promociones propias ---
  // Página con un h1 y una fila de íconos (a.obj_editor-link-text) que
  // enlazan a otras categorías del sitio (ej. "Adelantate verano" enlaza a
  // Automotores, Ómnibus, Hoteles y Balnearios). Esas categorías ya se
  // recorren por separado desde el índice principal, así que no se extrae
  // nada acá para no duplicar datos, y tampoco se cuenta como error.
  const enlacesDeCampania = await page.$$eval(
    '.internal_content_area a.obj_editor-link-text',
    (links) => links.map((a) => a.href)
  );
  if (tieneH1 && enlacesDeCampania.length > 0) {
    console.log(
      `${sangria}ℹ️  [landing de campaña] "${categoriaNombre}": sin promociones propias, enlaza a ${enlacesDeCampania.length} categorías que se procesan por separado. Se omite.`
    );
    return;
  }

  // --- Ningún patrón conocido: lo dejamos registrado para revisar a mano ---
  console.warn(
    `${sangria}⚠️  "${categoriaNombre}" (${urlCategoria}) no coincide con ningún patrón conocido (artículo / grilla CDNI / listado / sub-rubros / landing de campaña). Se omite.`
  );
  categoriasConError.push({
    categoria: categoriaNombre,
    error: 'Estructura de página no reconocida (revisar manualmente)',
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    // args recomendados para entornos sin sandbox (CI, contenedores, etc.)
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(SELECTOR_TIMEOUT);

  const todosLosBeneficios = []; // array consolidado final
  const categoriasConError = []; // para el README / log final

  try {
    console.log('➡️  Accediendo a la página principal de beneficios...');
    // Se usa domcontentloaded en vez de networkidle2: el widget de chat en
    // vivo del sitio mantiene la red activa y networkidle2 no se cumpliría.
    // El waitForSelector de #beneficios_rubros que sigue es la señal real de
    // que la página cargó lo necesario.
    await navegarConReintentos(page, BASE_URL);

    // Esperamos el contenedor principal de rubros/categorías
    await page.waitForSelector('#beneficios_rubros', { timeout: SELECTOR_TIMEOUT });

    // Primero contamos cuántas categorías hay (solo para saber el rango del bucle).
    // Solo hace falta la CANTIDAD acá; el href y el nombre de cada una se
    // vuelven a leer en cada vuelta del bucle (paso 1), para no depender de
    // datos que puedan haber quedado desactualizados.
    const totalCategorias = await page.$$eval(
      '#beneficios_rubros a',
      (links) => links.length
    );

    console.log(`🔎 Se encontraron ${totalCategorias} categorías en total.`);

    // -----------------------------------------------------
    // Bucle principal: recorremos categoría por categoría
    // -----------------------------------------------------
    // Índice de la última categoría que se reintentó con una pestaña nueva
    // (evita reintentar indefinidamente la misma categoría).
    let indiceReintentadoConPaginaNueva = -1;

    for (let i = 0; i < totalCategorias; i++) {
      const cantidadAntes = todosLosBeneficios.length;
      let categoriaProcesada = false;
      try {
        // 1) Re-scaneamos los enlaces de categorías EN CADA ITERACIÓN.
        //    Después de volver al índice (paso 5) el DOM se vuelve a
        //    renderizar, y los datos leídos en la vuelta anterior quedarían
        //    obsoletos ("stale") si se hubieran guardado de antes.
        await page.waitForSelector('#beneficios_rubros', { timeout: SELECTOR_TIMEOUT });

        const categoriasInfo = await page.$$eval('#beneficios_rubros a', (links) =>
          links.map((a) => ({
            href: a.href,
            // Muchas categorías son solo un ícono sin texto ni title, por eso
            // agregamos el alt de la imagen como fuente adicional de nombre.
            nombre:
              a.innerText.trim() ||
              a.getAttribute('title') ||
              a.querySelector('img')?.getAttribute('alt') ||
              'sin-nombre',
          }))
        );

        const categoriaActual = categoriasInfo[i];

        if (!categoriaActual) {
          console.warn(`⚠️  No se encontró la categoría en el índice ${i}. Se omite.`);
          continue;
        }

        // 2) Filtramos enlaces externos ANTES de hacer clic
        if (esLinkExterno(categoriaActual.href)) {
          console.log(
            `⏭️  Categoría "${categoriaActual.nombre}" es un enlace externo (${categoriaActual.href}). Se omite.`
          );
          continue;
        }

        console.log(
          `➡️  [${i + 1}/${totalCategorias}] Entrando a categoría: "${categoriaActual.nombre}"`
        );

        // 3) Navegamos DIRECTO a la URL de la categoría con page.goto(), sin
        //    clickear el ícono. El href ya se leyó del índice con $$eval, así
        //    que no hace falta simular un click, y se evitan dos problemas:
        //      - En categorías con navegación SPA la URL puede no cambiar, y
        //        esperar ese cambio demoraría cada categoría hasta el timeout.
        //      - El ElementHandle del ícono puede quedar obsoleto si la
        //        página se vuelve a renderizar justo antes del click.
        await navegarConReintentos(page, categoriaActual.href);

        // 4) Procesamos la categoría de forma recursiva: puede resolver
        //    directo (artículo único / listado) o encontrar sub-rubros y
        //    entrar a cada uno de ellos (ver caso "Entretenimientos").
        await procesarCategoria(
          page,
          categoriaActual.nombre,
          categoriaActual.href,
          todosLosBeneficios,
          categoriasConError
        );
        categoriaProcesada = true;

        // 5) Volvemos al índice de categorías para continuar el recorrido.
        //    Se navega con goto(BASE_URL) y no con "atrás" del navegador:
        //    si procesarCategoria() recursó por sub-rubros hizo varios
        //    goto() internos, y retroceder un solo paso del historial no
        //    alcanzaría. Así siempre queda en un estado conocido.
        await navegarConReintentos(page, BASE_URL);
      } catch (errorCategoria) {
        // Pestaña inutilizable (frame desprendido, etc.): se abre una nueva.
        // Si la categoría ya se había extraído y el fallo fue al volver al
        // índice, se sigue con la próxima; si no, se repite una sola vez
        // descartando lo que haya alcanzado a guardar, para no duplicar.
        if (esErrorDePaginaInutilizable(errorCategoria)) {
          console.warn(
            `   ⚠️  La pestaña quedó inutilizable (${errorCategoria.message}). Abriendo una pestaña nueva...`
          );
          page = await abrirPaginaNueva(browser, page);
          try {
            await navegarConReintentos(page, BASE_URL);
          } catch (errorBase) {
            console.error(
              `   ‼️  No se pudo volver al índice con la pestaña nueva: ${errorBase.message}`
            );
          }

          if (categoriaProcesada) continue;

          if (indiceReintentadoConPaginaNueva !== i) {
            indiceReintentadoConPaginaNueva = i;
            todosLosBeneficios.length = cantidadAntes;
            console.warn(`   ↻ Reintentando la categoría del índice ${i} con la pestaña nueva.`);
            i--;
            continue;
          }
        }

        // -----------------------------------------------------
        // Manejo de errores POR CATEGORÍA: no debe cortar todo el scraping
        // -----------------------------------------------------
        console.error(
          `❌ Error procesando la categoría en el índice ${i}: ${errorCategoria.message}`
        );
        categoriasConError.push({ indice: i, error: errorCategoria.message });

        // Recuperación de emergencia: volvemos directo a la página base con
        // goto(), porque tras una recursión por sub-rubros el historial del
        // navegador tiene varios pasos intermedios y "atrás" no alcanzaría.
        try {
          await navegarConReintentos(page, BASE_URL);
        } catch (errorGoto) {
          console.error(
            `   ‼️  No se pudo recuperar la navegación: ${errorGoto.message}`
          );
        }

        // Continuamos con la siguiente categoría sin perder lo ya acumulado
        continue;
      }
    }

    // -----------------------------------------------------
    // Guardado final del JSON consolidado
    // -----------------------------------------------------
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(todosLosBeneficios, null, 2));

    console.log('\n============================================');
    console.log(`✅ Proceso finalizado.`);
    console.log(`   Total de beneficios guardados: ${todosLosBeneficios.length}`);
    console.log(`   Archivo generado: ${OUTPUT_FILE}`);
    if (categoriasConError.length > 0) {
      console.log(
        `   ⚠️  Categorías con error (revisar log arriba): ${categoriasConError.length}`
      );
    }
    console.log('============================================\n');
  } catch (errorGeneral) {
    console.error('‼️  Error general e irrecuperable del script:', errorGeneral);
  } finally {
    await browser.close();
  }
})();

/**
 * ============================================================
 *  Estructura de página por patrón, y limitaciones conocidas
 * ============================================================
 *
 *  Patrón 1 - Artículo(s) de promoción (la mayoría de las categorías).
 *  Forma general de la página:
 *
 *    <h1>Título / vigencia de la campaña</h1>          <- puede repetirse
 *    <div class="dividerBenef"></div>                  <- separador visual (NO es límite de promo)
 *    <div class="benef2"><span class="porcentajePromo">20%</span></div>
 *    <h2 class="benef3">En [Rubro]</h2>                <- límite real entre una promo y la siguiente
 *    <p class="spacer">Condición 1</p>
 *    <p class="spacer">Condición 2</p>
 *    ... íconos de locales/marcas adheridas (a.obj_editor-link-text > img) ...
 *    (el bloque de arriba puede repetirse varias veces con nuevos benef3)
 *    <p class="legales">Letra chica...</p>             <- compartida por todas las promos de la página
 *
 *  `extraerPromocionesDeCategoria` recorre `.internal_content_area` con un
 *  TreeWalker y arma una lista de "eventos" en orden de documento; cada
 *  `h2.benef3` cierra la promo anterior y abre una nueva, absorbiendo los
 *  porcentajes vistos desde la promo anterior y las condiciones/locales
 *  hasta el próximo benef3. Devuelve un array de promociones por categoría.
 *
 *  Limitaciones de este patrón:
 *
 *  1) Categorías sin porcentaje fijo (ej. "Cuotas sin interés", "Sorteos")
 *     quedan con `porcentaje: null`.
 *
 *  2) Los legales se recolectan a nivel de página completa, no por promo
 *     individual (suelen estar referenciados por notas al pie compartidas
 *     -> (1), (2), (3) -> entre varias promos). Se adjunta el mismo bloque
 *     de legales a cada promoción de esa página. Separarlos con precisión
 *     por promo requeriría parsear esas referencias numéricas dentro de
 *     cada `condiciones`/`rubro` y cruzarlas contra el texto de cada
 *     `p.legales` (no implementado).
 *
 *  3) Si la categoría no tiene locales/marcas adheridas listadas,
 *     `locales_adheridos` devuelve un array vacío.
 *
 *  Patrón 4 - Sub-rubros por ícono. Algunas categorías son "paraguas" sin
 *  beneficios propios (tienen h1, pero ni h2.benef3, ni porcentaje, ni
 *  legales dentro de .internal_content_area) y agrupan sub-rubros
 *  representados como <img onclick="window.location.href='...'"> en vez de
 *  <a href>. Por eso `procesarCategoria()` es recursiva: si la categoría no
 *  coincide con los patrones 1 a 3, busca estos íconos con
 *  `extraerSubIconos()` y entra a cada uno.
 *
 *  Patrón 5 - Landing de campaña. Página con un h1 y una fila de íconos
 *  (a.obj_editor-link-text) que enlazan a otras categorías, sin promociones
 *  propias (ej. "Adelantate verano"). No se extrae nada porque las
 *  categorías enlazadas ya se recorren desde el índice principal; se
 *  registra como mensaje informativo y no como error.
 *
 *  Patrón 3 - #resultados_beneficios (`extraerDeResultadosBeneficios`):
 *  sin confirmar contra un HTML real con tarjetas cargadas. Sus selectores
 *  (`.w3-card`, `.beneficio-item`, filas de tabla) están basados en que el
 *  resto del sitio usa el framework W3.CSS, pero no se validaron contra
 *  una página real de este tipo. Si el script llega a activar este patrón
 *  en una corrida, conviene revisar el JSON resultante con cuidado antes
 *  de confiar en esos datos.
 * ============================================================
 */
