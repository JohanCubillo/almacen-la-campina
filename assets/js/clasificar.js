/* Almacén La Campiña · categoría automática para productos que vienen sin categoría
 * (por ejemplo, el inventario exportado de Moriah).
 * Se usa al importar: solo para productos NUEVOS que no traen categoría.
 * Las reglas van en orden: la primera que calza decide. Lo que no calza
 * queda en "Ferretería". En el panel se puede cambiar a mano después.
 */
(function () {
  "use strict";
  const CATEGORIAS = [
    "Materiales de construcción", "Acabados y paredes", "Electricidad", "Fontanería",
    "Herramientas eléctricas", "Herramientas manuales", "Ferretería", "Agro y jardín",
    "Hogar y limpieza", "Mascotas", "Pesca", "Automotriz", "Seguridad y ropa de trabajo"
  ];

  // palabra completa (acepta plural); para prefijos se escribe "fumiga[a-z]*"
  const R = (cat, ...pal) => [cat, new RegExp("(^|[^a-z0-9])(" + pal.join("|") + ")(e?s)?(?![a-z0-9])", "")];
  const REGLAS = [
    // casos que confunden a las reglas generales
    R("Herramientas manuales", "alicate", "corta ?vidrio", "llave (corofija|allen|inglesa|stilson|combinada|ajustable|cruz|torx|de tubo|mixta|estrella|boca|hexagonal|francesa)"),
    R("Ferretería", "tornillo", "torn", "tuerca", "arandela", "perno", "remache", "agarradera", "manija", "bisagra", "picaporte", "cerradura", "llavin", "haladera", "aldaba", "pasador", "candado"),
    R("Agro y jardín", "aislador", "herradura", "cerca electrica", "impulsor"),
    R("Electricidad", "bombillo", "foco", "lampara", "plafon", "reflector", "fluorescente", "spot", "centro (de )?carga", "breaker"),
    R("Automotriz", "agua (p/? ?)?bateria", "bici[a-z]*", "aro (bici|n.?[0-9]+ (trasero|delantero))"),
    R("Fontanería", "aspersion", "bomba (periferica|centrifuga|sumergible|p/? ?agua|de agua)"),
    R("Fontanería", "tubo (de )?abasto", "abasto", "biex", "manguera corrugada", "llave (de )?(chorro|control|empotrar)", "cachera", "empaque", "o-?ring", "desatorador", "destapa[a-z]*", "accesorio(s)? (de )?bano", "panera", "plomer[a-z]*"),
    R("Electricidad", "tubo emt", "emt", "caja (de paso|hexa|p/? ?canaleta)", "canaleta", "bateria (alcalina|alka|alkalina|reloj|redonda|litium|mediana|cr ?[0-9]+|rayo[a-z]*|aa|aaa|9v)", "rayovac", "rayobac", "spliter", "splitter", "ventilador", "audifono", "antena", "control remoto"),
    R("Herramientas eléctricas", "bateria [0-9]+ ?v", "p/? ?inalamb[a-z]*"),
    R("Acabados y paredes", "pistola (de )?gravedad", "pistola (p/|para|de) ?pintar"),
    R("Automotriz", "sae ?[0-9]+", "20w-?50", "relleno", "lavado (de )?motor[a-z]*", "limpieza (de )?motor[a-z]*", "bateria n[0-9]+", "neumatico", "cubierta"),
    R("Agro y jardín", "pistola (p/? ?)?(mang[a-z]*|riego)", "pistola (plast|met)[a-z]*", "hacha"),
    R("Pesca", "set de pescar", "pescar"),
    R("Herramientas manuales", "cepillo (de )?(acero|bronce|copa|alambre)", "juego (de )?(dest[a-z]*|llaves|herramientas|puntas|tarraj[a-z]*|centro|cep[a-z]*|piedras)", "cinta met[a-z]*", "piedra (de )?(afilar|asentar)", "molejon", "piedra p/? ?esmeril", "caja (de )?herram[a-z]*", "caja (plast )?herram[a-z]*", "caja inglete", "llave (cangrejo|caneria|fontanero)", "tarraja", "sacavuelta", "cizalla"),
    R("Materiales de construcción", "tubo est[a-z]*", "piedra (bola|quintilla|quinta|cuarta)", "plyrock", "plywo+d", "zincor", "metalum"),
    R("Hogar y limpieza", "cortinero", "aguja", "cosmetiquera", "rayador"),
    // muy específicos primero
    R("Pesca", "senuelo", "anzuelo", "carrete", "cana de pescar", "cana p/? ?pesca", "enganador", "plomada", "nylon p/? ?pesca", "pesca", "mosca"),
    R("Mascotas", "perro", "gato", "cat chow", "dog chow", "mascota", "collar", "correa p/? ?perro", "arena p/? ?gato", "pedigree", "whiskas", "antipulga", "pulga", "garrapat[a-z]*"),
    R("Automotriz", "neumatico", "llanta", "camara p/? ?(bici|moto|llanta)", "inflador", "caja de parches", "parche p/? ?(llanta|camara|neumatico)", "bujia", "aceite (de )?motor", "aceite 2t", "aceite 4t", "2 tiempos", "4 tiempos", "eter p/? ?arranque", "liquido de frenos", "refrigerante", "anticongelante", "bicicleta", "moto", "carro", "automo[a-z]*", "radiador", "valvulina", "llave de rueda", "gata hidraulica", "gato hidraulico", "cable de corriente p/? ?bateria"),
    R("Seguridad y ropa de trabajo", "guante", "bota", "anteojo", "lente de seguridad", "gafa", "mascarilla", "mascara", "careta", "casco", "chaleco", "capa", "pechera", "sombrero", "zapato", "tapon auditivo", "orejera", "faja", "arnes", "respirador", "delantal", "overol", "gorra", "senalizacion", "cono de seguridad"),
    R("Herramientas eléctricas", "taladro", "rotomartillo", "esmeriladora", "pulidora", "lijadora", "sierra (circular|caladora|electrica|ingleteadora|sable)", "caladora", "soldadora", "compresor", "hidrolavadora", "motosierra", "atornillador", "cautin", "pistola de calor", "router", "rebajadora", "cepillo electrico", "inalambric[a-z]*", "clavadora", "neumatic[a-z]*", "broca", "disco", "copa sierra", "sierra copa", "electrodo", "soldadura", "carbones", "cargador", "[0-9]+ ?w([^a-z]|$)", "[0-9]+ ?v (bateria|max)", "bateria (de )?litio", "mototool", "dremel", "pistola de impacto", "llave de impacto", "generador", "planta electrica"),
    R("Electricidad", "cable", "breaker", "toma(corriente)?", "tomacorrientes", "apagador", "interruptor", "switch", "bombillo", "foco", "lampara", "plafon", "spot", "reflector", "fluorescente", "led", "tubo led", "centro (de )?carga", "conduit", "cinta aislante", "tape electrico", "extension", "regleta", "enchufe", "fusible", "timbre", "terminal", "conector", "probador", "multimetro", "tester", "socket", "roseta", "sensor", "fotocelda", "trifulcador", "supresor", "regulador de voltaje", "ups", "pila", "bateria (aa|aaa|9v|d|c)", "amarra", "linterna", "caja (octagonal|rectang|cuadrada|de registro|electrica)", "varilla (cobre|polo|tierra)", "polo a tierra", "breque", "amp", "volt"),
    R("Fontanería", "pvc", "cpvc", "codo", "tee", "union", "niple", "reduccion", "reductor", "tapon", "adaptador (macho|hembra)", "valvula", "llave (de )?(paso|chorro|lavatorio|fregadero|ducha|bola|jardin|manguera)", "llave sencilla", "mezcladora", "grifo", "inodoro", "lavatorio", "fregadero", "sifon", "desague", "ducha", "aspercion", "regadera", "tanque", "flotador", "empaque p/? ?(llave|tubo|inodoro)", "teflon", "tape", "pegamento (pvc|cpvc|azul|para tubo)", "abrazadera", "gaza", "acople", "manguera (p/)?ducha", "cespol", "check", "bomba (de )?agua", "hidroneumatico", "rejilla p/? ?piso", "sanitari[a-z]*", "trampa de grasa", "tubo (pvc|de presion|sanitario|cpvc|hg|galvanizado)", "copa (pvc|reductora)", "curva"),
    R("Agro y jardín", "machete", "manguera", "aspersor", "bomba (de )?(fumigar|espalda|mochila)", "fumiga[a-z]*", "pulverizador", "atomizador", "herbicida", "insecticida", "fungicida", "veneno", "abono", "fertilizante", "semilla", "pollit[a-z]*", "concentrado", "alimento (p/)?(gallina|cerdo|ganado|pollo|pez)", "puas", "grapa (cerca|p/? ?cerca)", "bebedero", "comedero", "chapear", "motoguadana", "guadana", "chapeadora", "carretillo", "tijera (de )?podar", "podadora", "macetero", "maceta", "tierra", "sustrato", "rastrillo", "azadon", "pala", "pico", "coba", "barreton", "ganado", "vacuna", "jeringa", "cedazo", "malla (gallinera|ciclon|sombra)", "saran", "romana", "mecate", "cabuya", "carbolina", "creolina", "matamaleza", "glifosato", "cuchillo de campo", "lima p/? ?machete", "jardin"),
    R("Herramientas manuales", "martillo", "mazo", "alicate", "pinza", "tenaza", "llave (corofija|allen|inglesa|stilson|combinada|ajustable|cruz|torx|de tubo|mixta|estrella|boca|hexagonal|francesa)", "juego de llaves", "llaves (allen|combinadas|corofijas|torx)", "destornillador", "desatornillador", "destorn", "serrucho", "segueta", "marco (de )?sierra", "hoja de segueta", "nivel", "cinta metrica", "metro", "flexometro", "escuadra", "cuchara", "llana", "llaneta", "palustre", "espatula", "formon", "cincel", "punzon", "lima", "escofina", "prensa", "sargento", "cubo", "rache", "ratchet", "extension p/? ?(rache|cubo)", "cutter", "cuchilla", "navaja", "tijera", "remachadora", "engrapadora", "pistola (de )?silicon", "pistola p/? ?silicon", "barra", "pata de cabra", "cortadora", "cortafrio", "caja de herramienta", "organizador", "escalera", "carretilla", "plomo", "tiralinea", "chaira", "sacabocado", "juego (de )?(desarmadores|destornilladores|dados)", "dados", "torquimetro", "cepillo (de )?alambre", "cepillo (de )?carpintero", "gubia", "serrote"),
    R("Acabados y paredes", "pintura", "brocha", "pincel", "rodillo", "felpa", "bandeja p/? ?(pintura|rodillo)", "sellador", "masilla", "lija", "thinner", "diluyente", "esmalte", "barniz", "laca", "tinte", "anticorrosivo", "fondo", "base (de )?agua", "spray", "aerosol", "masking", "maskin", "silicon", "ceramica", "porcelanato", "fragua", "pegamix", "bondex", "pega(mento)? (para )?(ceramica|azulejo)", "cielo raso", "lamina pvc", "pvc marmol", "zocalo", "moldura", "gypsum", "pasta (de )?(muro|pared)", "sika", "impermeabiliz[a-z]*", "cera", "estuco", "texturizado", "corona", "esquinero", "rodapie", "cinta de enmascarar", "removedor", "aguarras", "espiritu mineral", "varsol"),
    R("Materiales de construcción", "cemento", "block", "bloque", "varilla", "arena", "piedra cuarta", "lastre", "piedrilla", "concreto", "mortero", "repello", "cal", "carbonato de calcio", "perling", "perfil", "angular", "platina", "tubo (estructural|industrial|rectangular|cuadrado|redondo)", "lamina", "lam", "zinc", "zin", "teja", "cumbrera", "canoa", "botagua", "bajante", "plycem", "fibrolit", "fibrocemento", "durock", "madera", "regla", "tabla", "reglilla", "alfajilla", "clavador", "viga", "malla (electrosoldada|de construccion|expandida)", "alambre (negro|de amarre|recocido)", "aro", "estribo", "canal track", "canal", "track", "stud", "poste", "formaleta", "hierro", "baldosa", "adoquin", "tapichel", "cerco", "puerta", "ventana", "vidrio", "policarbonato", "traslucida", "aislante termico", "fibra de vidrio", "panel"),
    R("Hogar y limpieza", "suavitel", "dash", "cloro", "jabon", "detergente", "desinfectante", "limpiador", "limpia", "lavaplatos", "escoba", "palo de piso", "trapeador", "mecha", "balde", "bolsa (de )?basura", "basurero", "papel higienico", "servilleta", "toalla", "vaso", "plato", "taza", "olla", "sarten", "cuchillo", "cuchara de cocina", "tenedor", "licuadora", "cocina", "encendedor", "fosforo", "vela", "ratonera", "trampa", "raid", "baygon", "repelente", "ambientador", "aromatizante", "esponja", "shampoo", "pasta dental", "cepillo de dientes", "desodorante", "crema", "algodon", "pañal", "panal", "abrillantador", "cafe", "jugo", "galleta", "helado", "cajeta", "confite", "refresco", "agua", "azucar", "arroz", "frijol", "sal", "aceite (de )?cocina", "canasta", "tendedero", "gancho (de )?ropa", "pinza(s)? (de )?ropa", "colador", "embudo", "termo", "hielera", "silla", "mesa", "espejo", "cortina", "alfombra", "almohada"),
    R("Ferretería", "tornillo", "torn", "perno", "tuerca", "arandela", "clavo", "grapa", "taco", "ancla", "remache", "bisagra", "candado", "cerradura", "llavin", "picaporte", "pasador", "aldaba", "haladera", "agarradera", "manija", "pomo", "rodin", "rueda", "cadena", "gancho", "argolla", "tensor", "cable de acero", "linga", "eslinga", "spander", "espander", "pulpo", "cuerda", "soporte", "escuadra", "angulo", "riel", "corredera", "pegamento", "super glue", "kola loca", "epoxi", "cinta (doble|adhesiva|de embalar|transparente)", "tape", "alambre galva", "malla", "lubricante", "grasa", "aceite 3 en 1", "wd-?40", "chapa", "buzon", "numero", "letrero")
  ];

  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ñ/g, "n").replace(/\s+/g, " ").trim();

  function clasificar(nombre) {
    const n = " " + norm(nombre) + " ";
    for (const [cat, re] of REGLAS) if (re.test(n)) return cat;
    return "Ferretería";
  }

  const api = { clasificar, CATEGORIAS };
  if (typeof window !== "undefined") window.Clasificar = api;
  if (typeof module !== "undefined") module.exports = api;
})();
