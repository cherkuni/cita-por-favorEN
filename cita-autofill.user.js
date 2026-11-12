// ==UserScript==
// @name         Cita Por Favor — TIE Fingerprints, Card Pickup & NIE Checker (Barcelona, EN/RU)
// @name:ru      Cita Por Favor — huellas + tarjetas + recogida TIE + asignación NIE (Barcelona, вся провинция)
// @namespace    cita-catcher.local
// @version      9.25.4
// @description  Local browser assistant for checking Barcelona Extranjería appointments (toma de huellas, expedición de tarjetas, recogida TIE, asignación NIE). Autofills applicant details, supports Cl@ve / Digital Certificate, and alerts via voice when slots are found. Bilingual EN/RU UI.
// @description:ru Cita Por Favor проверяет ситы по провинции Барселона («Cualquier oficina» — вся провинция, или офисы, выбранные галочками на панели): вкладка сама проверяет наличие сит на toma de huellas, expedición de tarjetas, recogida de tarjeta (получение готовой TIE) и asignación de NIE (первичное назначение номера), при находке заполняет форму и зовёт голосом компьютера — за человеком только SMS-код и Confirmar. Ритм задаётся отдельными пресетами для часовых окон и интервального режима; свои пресеты можно сохранять. Без обхода защиты: реальный браузер, человеческий темп, backoff при блокировке. Личные данные вводятся через панель (кнопка «Изменить мои данные») и хранятся только в Tampermonkey. При входе через Cl@ve можно записать себя или другого человека.
// @match        https://icp.administracionelectronica.gob.es/*
// @match        https://pasarela.clave.gob.es/*
// @match        https://*.clave.gob.es/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  // Версия берётся из шапки (@version) и видна на панели в приписке внизу —
  // чтобы одним взглядом проверять, какая версия реально стоит в Tampermonkey.
  const SCRIPT_VER =
    (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '?';

  // ============ ЛИЧНЫЕ ДАННЫЕ ============
  // В коде их НЕТ: заполняются один раз через кнопку «👤 Изменить мои данные» на панели
  // и хранятся в хранилище Tampermonkey (переживают обновления скрипта).
  const DATA_DEFAULTS = {
    lang: 'en',                 // язык панели (en по умолчанию; переключатель EN/RU на панели)
    docType: 'NIE',             // NIE или PASSPORT (выбор в панели)
    docNumber: '',
    fullName: '',
    birthYear: '',
    country: '',                // точное название из списка на сайте
    phone: '',
    email: '',
    tramites: ['huellas'],      // какие услуги проверять (ключи из TRAMITES)
    offices: [],                // какие офисы брать (ключи из OFFICES; [] = вся провинция, любой)
    officeAny: false,           // ситы есть, но выбранных офисов нет — брать любой
    office: '',                 // легаси-поле для отката на ≤9.21: ключ при ровно одном офисе, иначе ''
    useClave: false,            // вход через Cl@ve: скрипт зовёт человека авторизоваться
    claveCert: false,           // Cl@ve через сертификат (eIdentifier) — авто-клик плитки
    copyFromClave: true,        // false = записываем ДРУГОГО человека: «Copiar a datos
                                // solicitante» не жмём, имя/NIE/год — из «Моих данных»
  };
  const store = {
    get: (k, d) => (typeof GM_getValue === 'function')
      ? GM_getValue(k, d) : (localStorage.getItem('gm_' + k) ?? d),
    set: (k, v) => (typeof GM_setValue === 'function')
      ? GM_setValue(k, v) : localStorage.setItem('gm_' + k, v),
  };
  let DATA = { ...DATA_DEFAULTS };
  try { DATA = Object.assign({}, DATA_DEFAULTS, JSON.parse(store.get('ck_data', '{}'))); } catch (e) {}
  if (!DATA.useClave) DATA.claveCert = false; // сертификат существует только внутри Cl@ve
  // разовая миграция 9.21 → 9.22: закреплённый офис переезжает в массив
  if (!Array.isArray(DATA.offices)) DATA.offices = [];
  if (DATA.office && !DATA.offices.includes(DATA.office)) DATA.offices = [DATA.office];
  // сохранение с поддержкой легаси-поля office: откат на 9.21 не теряет выбор
  function persistData() {
    DATA.office = DATA.offices.length === 1 ? DATA.offices[0] : '';
    store.set('ck_data', JSON.stringify(DATA));
  }
  const dataReady = () => !!(DATA.docNumber && DATA.fullName && DATA.phone && DATA.email);

  // ============ ЯЗЫК ИНТЕРФЕЙСА (i18n: EN по умолчанию + RU, расширяемо) ============
  // Чтобы добавить новый язык позже, достаточно добавить код в LANGUAGES и
  // передать перевод в extra-аргумент L(ru, en, { es: '...' }).
  const LANGUAGES = {
    en: { label: 'EN · English', ttsLang: 'en-US' },
    ru: { label: 'RU · Русский', ttsLang: 'ru-RU' },
  };
  function getLang() {
    return LANGUAGES[DATA.lang] ? DATA.lang : 'en';
  }
  function L(ru, en, extra) {
    const lg = getLang();
    if (lg === 'ru') return ru;
    if (extra && extra[lg] !== undefined) return extra[lg];
    return en;
  }

  // Офисы провинции Барселона — список снят с сайта citar?p=8 (02.09.2026):
  // 24 комиссариа провинции + 4 офиса собственно Барселоны. По умолчанию ничего
  // не выбрано («Cualquier oficina») — слоты всей провинции, прежнее поведение.
  // key — ключ поиска опции в #sede/#idSede (findOption/pickOffice ищут
  // подстроку в верхнем регистре без диакритиков). Ключи подобраны так, чтобы
  // не совпасть с улицей чужого офиса: у Руби улица называется TERRASSA,
  // поэтому Terrassa ищем как «COMISARIA TERRASSA», Vic — «COMISARIA VIC».
  // short — метка для журнала
  // (бюджет строки ~40 символов, см. CLAUDE.md).
  const OFFICES = [
    { key: '', short: '', label: 'Вся провинция (Cualquier oficina)' },
    { key: 'BADALONA', short: 'BADALONA', label: 'Badalona' },
    { key: 'CASTELLDEFELS', short: 'CASTELLDEFELS', label: 'Castelldefels' },
    { key: 'CERDANYOLA', short: 'CERDANYOLA', label: 'Cerdanyola del Vallès' },
    { key: 'CORNELLA', short: 'CORNELLA', label: 'Cornellà de Llobregat' },
    { key: 'PRAT DE LLOBREGAT', short: 'PRAT', label: 'El Prat de Llobregat' },
    { key: 'GRANOLLERS', short: 'GRANOLLERS', label: 'Granollers' },
    { key: 'IGUALADA', short: 'IGUALADA', label: 'Igualada' },
    { key: 'HOSPITALET', short: 'HOSPITALET', label: "L'Hospitalet de Llobregat" },
    { key: 'MANRESA', short: 'MANRESA', label: 'Manresa' },
    { key: 'MATARO', short: 'MATARÓ', label: 'Mataró' },
    { key: 'MONTCADA', short: 'MONTCADA', label: 'Montcada i Reixac' },
    { key: 'RIPOLLET', short: 'RIPOLLET', label: 'Ripollet' },
    { key: 'RUBI', short: 'RUBÍ', label: 'Rubí' },
    { key: 'SABADELL', short: 'SABADELL', label: 'Sabadell' },
    { key: 'SANT ADRIA', short: 'SANT ADRIA', label: 'Sant Adrià del Besòs' },
    { key: 'SANT BOI', short: 'SANT BOI', label: 'Sant Boi de Llobregat' },
    { key: 'SANT CUGAT', short: 'SANT CUGAT', label: 'Sant Cugat del Vallès' },
    { key: 'SANT FELIU', short: 'SANT FELIU', label: 'Sant Feliu de Llobregat' },
    { key: 'SANTA COLOMA', short: 'SANTA COLOMA', label: 'Santa Coloma de Gramenet' },
    { key: 'COMISARIA TERRASSA', short: 'TERRASSA', label: 'Terrassa' },
    { key: 'COMISARIA VIC', short: 'VIC', label: 'Vic' },
    { key: 'VILADECANS', short: 'VILADECANS', label: 'Viladecans' },
    { key: 'VILAFRANCA', short: 'VILAFRANCA', label: 'Vilafranca del Penedès' },
    { key: 'VILANOVA', short: 'VILANOVA', label: 'Vilanova i la Geltrú' },
    { key: 'GUADALAJARA', short: 'BCN-GUADALAJARA', label: 'Barcelona · Guadalajara 1' },
    { key: 'MALLORCA GRANADOS', short: 'BCN-MALLORCA', label: 'Barcelona · Mallorca 213 (Granados)' },
    { key: 'PSJ', short: 'BCN-PSJ', label: 'Barcelona · Passeig Sant Joan 189' },
    { key: 'RAMBLA GUIPUSCOA', short: 'BCN-RAMBLA', label: 'Barcelona · Rambla Guipúscoa 74' },
  ];
  // v9.22: выбранные офисы — галочки на панели. Пусто = вся провинция.
  // Ровно один — точечный поиск по нему; два и больше — ищем всю провинцию
  // (Cualquier), а на экране офисов берём только выбранные: чужие = «сит нет».
  function selectedOffices() {
    return OFFICES.filter((o) => o.key && DATA.offices.includes(o.key));
  }
  // галка «брать любой» видна и действует только при 2+ офисах: при всей
  // провинции любой офис берём и так, при одном «любой» противоречит смыслу
  // точечного режима. Скрытая галка выключена ПО ЭФФЕКТУ — включённое
  // положение не срабатывает незаметно; само DATA.officeAny не сбрасываем,
  // галка вернётся в прежнем положении, когда офисов снова станет 2+.
  const officeAnyEffective = () => DATA.officeAny && selectedOffices().length >= 2;
  // короткая подпись для журнала (бюджет строки ~40 символов, см. выше)
  function officesShort() {
    const sel = selectedOffices();
    if (!sel.length) return L('провинция', 'province');
    return sel.length === 1 ? sel[0].short : L('офисы ', 'offices ') + sel.length;
  }
  // режим поиска — одинаково формулируем в сводке секции, подсказке и статусе,
  // чтобы было видно, ЧТО именно меняет количество галочек
  function officesModeShort() { // сводка секции (видна и свёрнутой)
    const sel = selectedOffices();
    if (!sel.length) return L('Вся провинция — берём любой офис', 'All province — take any office');
    if (sel.length === 1) return sel[0].short + L(' — ищем только этот офис', ' — check only this office');
    return sel.length + L(' офисов — ищем всю провинцию, берём свои', ' offices — check all province, take selected');
  }
  function officesModeHint() { // подсказка внутри списка
    const sel = selectedOffices();
    if (!sel.length) return L(
      'Поиск по всей провинции; на экране офисов берём любой.',
      'Searches the whole province; takes any available office.'
    );
    if (sel.length === 1) return L('Поиск только по этому офису.', 'Searches only this specific office.');
    return L(
      'Каждый заход ищет всю провинцию (Cualquier oficina), бронь — только выбранные офисы; чужие = «сит нет».',
      'Each check searches the whole province (Cualquier oficina), bookings only for selected offices; others = "no slots".'
    );
  }
  function officesModeStatus() { // статус после смены выбора
    const sel = selectedOffices();
    if (!sel.length) return L(
      'Офисы: вся провинция — берём любой; со следующего захода',
      'Offices: all province — take any; from next check'
    );
    if (sel.length === 1) return L(
      'Офисы: ' + sel[0].short + ' — только его; со следующего захода',
      'Offices: ' + sel[0].short + ' — only this one; from next check'
    );
    return L(
      'Офисы: ' + sel.length + ' шт — ищу всю провинцию, беру свои; со следующего захода',
      'Offices: ' + sel.length + ' selected — search province, take mine; from next check'
    );
  }
  // Услуги, которые умеем ловить. Галочки — в «🔎 Настройки поиска».
  // Если отмечено несколько, чекер чередует их по кругу (нагрузка не растёт).
  const TRAMITES = [
    { key: 'huellas',
      label: 'TOMA DE HUELLAS (expedición de tarjeta)',
      labelEn: 'TOMA DE HUELLAS (fingerprints / TIE card renewal & issuance)',
      keyword: 'TOMA DE HUELLAS' },
    { key: 'tarjetas',
      label: 'EXPEDICIÓN DE TARJETAS (Dirección General de Gestión Migratoria)',
      labelEn: 'EXPEDICIÓN DE TARJETAS (Dirección General de Gestión Migratoria)',
      keyword: 'GESTIÓN MIGRATORIA' },
    // v9.23 (контриб тестера, 24.09): в некоторых отделениях на ПОЛУЧЕНИЕ
    // готовой карточки тоже нужна сита — ловим и её. Ключ 'RECOGIDA DE TARJETA'
    // совпадает и с «TARJETA», и с «TARJETAS», с huellas/tarjetas не пересекается.
    { key: 'recogida',
      label: 'RECOGIDA DE TARJETA (TIE) — получение готовой карты',
      labelEn: 'RECOGIDA DE TARJETA (TIE) — pick up ready card',
      keyword: 'RECOGIDA DE TARJETA' },
    // v9.23.1 (просьба пользовательницы, 30.09): «POLICIA — ASIGNACIÓN NIE» —
    // первичное назначение номера NIE. Ключ 'ASIGNACION NIE' с существующими
    // не пересекается. Нюанс данных: NIE у человека ещё нет — в «моих данных»
    // документ выбирать «Паспорт».
    { key: 'nie',
      label: 'ASIGNACIÓN DE NIE (Policía — первое получение номера)',
      labelEn: 'ASIGNACIÓN DE NIE (Policía — first-time NIE number)',
      keyword: 'ASIGNACION NIE' },
  ];
  function activeTramites() {
    const sel = TRAMITES.filter((t) => (DATA.tramites || []).includes(t.key));
    return sel.length ? sel : [TRAMITES[0]];
  }
  // текущая услуга цикла: без активной проверки — первая отмеченная, в проверке — по кругу
  function currentTramite() {
    const list = activeTramites();
    if (!driving()) return list[0];
    const i = parseInt(SS.get('tramIdx') || '0', 10) % list.length;
    return list[i];
  }
  function nextTramite() {
    SS.set('tramIdx', String(parseInt(SS.get('tramIdx') || '0', 10) + 1));
  }
  // подписи для журнала: [значок, текст RU, текст EN]. ⚠️ — только настоящие ошибки.
  const LOG_LABELS = {
    NO_SLOTS:          ['·', 'сит нет', 'no slots'],
    SLOTS_FOUND:       ['🎉', 'СИТЫ найдены', 'SLOTS FOUND'],
    SLOTS_CAPTCHA:     ['🎉', 'СИТЫ — введи капчу', 'SLOTS — enter captcha'],
    SLOTS_FOUND_FINAL: ['🎉', 'СИТЫ — финал, SMS+Confirmar', 'SLOTS — final, SMS+Confirmar'],
    SLOTS_CONFIRMED:   ['✅', 'СИТА ПОДТВЕРЖДЕНА', 'APPOINTMENT CONFIRMED'], // после Confirmar, экран успеха
    CONFIG:            ['⚙️', 'старт', 'start'],
    RESUMED:           ['🔄', 'ожил после заморозки', 'resumed after freeze'],
    CLAVE_NEEDED:      ['🔐', 'Cl@ve: нужен вход', 'Cl@ve: login needed'],
    CLAVE_AUTH_WAIT:   ['🔐', 'Cl@ve: авторизация', 'Cl@ve: waiting auth'],
    SLOTS_LOST:        ['⚠️', 'слоты сорвались', 'slots lost'],
    WAF_BLOCKED:       ['⚠️', 'блок сайта', 'site block'],
    CODE_BLOCK:        ['⚠️', 'бот-блок', 'bot-block'],
    UNKNOWN:           ['⚠️', 'незнакомая страница', 'unknown page'],
    SITE_ERROR:        ['⚠️', 'ошибка сайта', 'site error'],
    SITE_MAINTENANCE:  ['🛠️', 'обслуживание сайта', 'site maintenance'],
    TRAMITE_MISSING:   ['⚠️', 'услуга недоступна', 'service unavailable'],
    OFFICE_MISSING:    ['⚠️', 'офиса нет', 'office missing'],
    OFFICE_NOTOURS:    ['·', 'ситы не в моих', 'slots not in mine'], // строка ≤40: «· ситы не в моих: 3 чужих»
    SESSION_LOOP:      ['⚠️', 'сессия не восстанавливается', 'session recovery failed'],
  };
  function logLabelText(state) {
    const row = LOG_LABELS[state];
    return row ? L(row[1], row[2] || row[1]) : state;
  }

  // короткая сводка активных настроек — для журнала и панели.
  // v9.2: офис показываем только в журнале (withOffice) — на панели офисы и так
  // видны в секции выше; пресет ритма тоже не выносим сюда — он виден в
  // списке пресетов «Настроить ритм проверки», к ритму и относится.
  function settingsSummary(withOffice = true) { // журнал — с офисом; панель просит без
    const parts = [(DATA.tramites || []).join('+') || 'huellas'];
    if (DATA.useClave) parts.push(DATA.claveCert ? L('Cl@ve-серт', 'Cl@ve-cert') : L('Cl@ve-моб', 'Cl@ve-mob'));
    else parts.push(L('аноним', 'no-Cl@ve'));
    if (withOffice) {
      const sel = selectedOffices();
      if (sel.length === 1) parts.push(L('офис ', 'office ') + sel[0].short);
      else if (sel.length > 1) parts.push(L('офисы ', 'offices ') + sel.length);
    }
    return parts.join(' · ');
  }

  // ============ НАСТРОЙКИ ЧЕКЕРА ============
  // РИТМ ПРОВЕРОК (окна/интервалы, потолок окна, перепроверка после срыва слотов)
  // с v8.0 НЕ здесь: он редактируется
  // на панели (кнопка «⚙️ Настроить ритм проверки») и хранится в Tampermonkey — см. RUN
  // и BUILTIN_PRESETS ниже. Здесь остаётся поведение, пресетами не меняемое.
  const CONFIG = {
    // Человеческий ввод данных (шаг 3, форма заявителя): поля NIE/имя/год/страна
    // заполняем ПО ОЧЕРЕДИ с паузами, иначе сайт даёт код 0017 «слишком быстрый
    // ввод» и ложно показывает «нет сит». Эту форму чекер печатает В ЛЮБОМ режиме
    // (и Cl@ve/сертификат, и аноним) — сертификат даёт авторизацию, но данные
    // заявителя сайт всё равно просит ввести. Отсюда 0017 даже по сертификату.
    humanFillMinSec: 0.9,        // пауза между полями при вводе, сек (случайно 0.9–1.9)
    humanFillMaxSec: 1.9,
    // Форма заявителя (шаг 3, NIE/имя/год/страна) — экран, на котором ситы
    // сгорают чаще всего (замер Екатерины 03.09: ~9 из 10 находок умирают
    // после него). После «Copiar» из Cl@ve нашей печати там почти нет
    // (радиокнопка, иногда год, страна) — паузы personalFill* короче базовых,
    // а остаток полей и страна делаются ОДНИМ шагом: весь экран ~3 с вместо ~6.
    // 0017 раньше давала мгновенная ПЕЧАТЬ полей — её больше нет; но следим:
    // «бот-блок 0017» в журнале = вернуть 0.9/1.9. Анонимный режим (без
    // «Copiar») печатает сам — для него шаги остаются раздельными, как раньше.
    personalFillMinSec: 0.7,
    personalFillMaxSec: 1.3,
    // Экран телефона/почты (шаг 5) — быстрее формы заявителя: код 0018 ловился
    // только на мгновенном (<1 с на всё) заполнении. Паузы 0.5–1.0 с: весь ввод
    // ~3 с вместо ~6. Контроль: в журнале появился «бот-блок 0018» — вернуть
    // 0.9/1.9 (как в v7.24) и сказать ИИ-сессии.
    contactFillMinSec: 0.5,
    contactFillMaxSec: 1.0,
    maxConsecutiveBlocks: 5,     // после стольких WAF-блоков (близких по времени) — полная остановка
    blockDecayMin: 60,           // блоки в пределах N мин считаются подряд (backoff растёт);
                                 // после чистого промежутка >N мин счётчик обнуляется
    // Паузы после блоков, минут (дальше — последнее значение). Замер по journal.log
    // за 28–30.07: после 20 мин первый запрос снова ловил блок (успех 1 из 3),
    // после 40+ мин — успех 4 из 4. Значит наказание за 429 длится дольше 20 мин.
    // Ставим 30 как ЗАМЕР границы: если после 30 мин запрос проходит — этого хватает;
    // если снова блок — граница выше 30, ставить 40 (известно рабочее). Второй шаг 60
    // заведомо выше рабочего 40, чтобы после неудачной тридцатки точно расцепиться.
    backoffMin: [30, 60, 120, 120],
    alertServer: 'http://127.0.0.1:8765', // голосовой хелпер alert-server.py
    alertRepeatSec: 80,          // повторять голосовой алерт, пока не нажато «Я тут»
    unknownAfterSec: 75,         // незнакомая страница дольше N секунд = UNKNOWN
                                 // (с запасом: на заблокированном экране таймеры реже, страницы грузятся дольше)
    unknownRetryMin: 7,          // после случайного UNKNOWN — повторить через N минут
    maxConsecutiveUnknown: 3,    // столько UNKNOWN подряд = вёрстка правда поменялась, стоп
    stallAfterSec: 45,           // нет прогресса после находки дольше N секунд = зови на помощь
    saveFoundHtml: true,         // при находке сохранять HTML-снимок страницы (доказательство: ситы, не ошибка)
    FORCE_FOUND: false,          // debug: вести себя так, будто ситы найдены
  };
  const DEFAULT_START = 'https://icp.administracionelectronica.gob.es/icpplustieb/citar?p=8&locale=es';

  // ============ РИТМ ПРОВЕРОК — RUN (редактируется на панели, v8.0) ============
  // Всё, что раньше было зашито в CONFIG: стратегии ритма, потолок окна и
  // перепроверка после срыва слотов. Форсаж — отдельная ручная настройка.
  // Значения живут
  // в Tampermonkey (ck_run) и переживают обновления скрипта. Пресеты —
  // готовые наборы для каждого режима (не удаляются) + свои,
  // сохранённые кнопкой «💾 Сохранить как пресет» (ck_presets).
  const RUN_DEFAULTS = {
    mode: 'hourly',              // основной понятный режим: серия в начале часа
    hourlyWindowMin: 10,         // первые N минут каждого часа
    hourlyChecks: 5,             // ровно столько автоматических проверок в окне
    // Базовый темп — ровный. Ускорение можно включить только для часов,
    // которые пользователь подтвердил собственными наблюдениями.
    intervalMinMin: 7,            // спокойный интервал, мин (случайный между min и max)
    intervalMaxMin: 10,
    hotHours: '',                  // пусто = ускорения по часам нет
    hotIntervalMinSec: 60,        // интервал в горячие часы, сек (в среднем ~120 с →
    hotIntervalMaxSec: 180,       // ~5 проверок за ~11 мин, вразброс; потолок сверху)
    // ЖЁСТКИЙ ПОТОЛОК + СЛУЧАЙНЫЙ РАЗБРОС (главная защита и стратегия).
    // Данные 22–23.07: 5 проверок за скользящие ~11 мин сайт терпит, 6-я =
    // WAF-бан. Держим ≤maxPerWindow за windowMin: упёрлись — ждём, пока
    // старейшая проверка выпадет из окна (гарантия «≤N/окно»). Проверки идут
    // ВРАЗБРОС — разброс лучше пар по покрытию всплеска и человечнее.
    maxPerWindow: 5,
    windowMin: 11,                // 5 за 11 мин (не 10) — запас от порога WAF
    activeFrom: 6,                // работать с часа (0 = ночью не спать)
    activeTo: 23,                 // …до часа (24 = ночью не спать)
    boostSec: 145,                // форсаж (галочка на панели): интервал проверки, сек (±15%, min ~123s → ≤5 проверок за 11 мин)
    lostRetryMinSec: 5,           // слоты сорвались (SLOTS_LOST): сорванная бронь часто
    lostRetryMaxSec: 12,          // СРАЗУ возвращается — перепроверяем почти мгновенно, а не
                                  // по обычному ритму. Потолок windowMin обходим сознательно:
                                  // ловим уже существовавший слот (+ проход формы ~15–25 с)
  };
  // Каждый встроенный пресет содержит только параметры своей стратегии;
  // общие пределы хранятся с ним, форсаж — всегда отдельно.
  const BUILTIN_PRESETS = {
    'Рекомендованные часовые окна': {
      mode: 'hourly',
      hourlyWindowMin: 10,
      hourlyChecks: 5,
      maxPerWindow: 5,
      windowMin: 11,
      lostRetryMinSec: 5,
      lostRetryMaxSec: 12,
    },
    'Рекомендованный интервальный ритм': {
      mode: 'interval',
      intervalMinMin: 7,
      intervalMaxMin: 10,
      hotHours: '',
      hotIntervalMinSec: 60,
      hotIntervalMaxSec: 180,
      activeFrom: 6,
      activeTo: 23,
      maxPerWindow: 5,
      windowMin: 11,
      lostRetryMinSec: 5,
      lostRetryMaxSec: 12,
    },
  };
  const PRESET_NAMES_EN = {
    'Рекомендованные часовые окна': 'Recommended hourly windows',
    'Рекомендованный интервальный ритм': 'Recommended interval rhythm',
    '(свои)': '(custom)',
  };
  const presetDisplay = (name) => L(name, PRESET_NAMES_EN[name] || name);
  // RUN сама по себе. Пресетом не меняется, правка поля пресет не сбрасывает.
  for (const p of Object.values(BUILTIN_PRESETS)) delete p.boostSec;
  // разбор «6-13, 19-23» → [[6,13],[19,23]]; null = формат неверный
  function parseHotHours(text) {
    const out = [];
    for (const part of String(text || '').split(',')) {
      const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (!m) return null;
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b || b > 24) return null;
      out.push([a, b]);
    }
    return out.length ? out : null;
  }
  // «7» = точный интервал, «7–10» / «7-10» = случайный диапазон минут.
  function parseIntervalRange(text, lo = 0.1, hi = 720) {
    const m = String(text || '').trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    const a = parseFloat(m[1]), b = parseFloat(m[2] || m[1]);
    if (!isFinite(a) || !isFinite(b) || a < lo || b > hi) return null;
    return a <= b ? [a, b] : [b, a];
  }
  const formatIntervalRange = (a, b) => a === b ? String(a) : a + '–' + b;
  function readCustomPresets() {
    try { return JSON.parse(store.get('ck_presets', '{}')) || {}; } catch (e) { return {}; }
  }
  function writeCustomPresets(obj) { store.set('ck_presets', JSON.stringify(obj)); }
  function applyPreset(name) {
    const raw = Object.assign({}, BUILTIN_PRESETS, readCustomPresets())[name];
    const p = raw && (raw.mode ? raw : Object.assign({ mode: 'interval' }, raw));
    if (!p) return false;
    // v9.3: интервал форсажа пресетом не трогаем — он стоит в merge последним
    // и перекрывает boostSec даже из пресетов, сохранённых до v9.2
    RUN = Object.assign({}, RUN_DEFAULTS, p, { preset: name, boostSec: RUN.boostSec });
    SS.del('boostUntil'); // v9.0: авто-форсаж ушёл, ключ от него протух — подчистить
    store.set('ck_run', JSON.stringify(RUN));
    return true;
  }
  let RUN = { preset: 'Рекомендованные часовые окна', ...RUN_DEFAULTS };
  try {
    const saved = JSON.parse(store.get('ck_run', 'null'));
    if (saved) {
      // Старые настройки были только интервальными: не меняем их молча.
      RUN = Object.assign({ preset: 'Рекомендованные часовые окна' }, RUN_DEFAULTS, saved);
      if (!saved.mode) RUN.mode = 'interval';
      // One-time migration: bump unsafe boostSec (<145s) to 145s default so continuous Boost stays ≤5 checks / 11 min
      if (!store.get('ck_boostSafeMigrated', '') && RUN.boostSec < 145) {
        RUN.boostSec = 145;
        store.set('ck_run', JSON.stringify(RUN));
      }
    }
    store.set('ck_boostSafeMigrated', '1');
  } catch (e) {}
  delete RUN.boost; delete RUN.boostMin; // v9.0: авто-форсаж ушёл — не тащить ключи в новые сохранения
  // ==========================================

  // ---------- состояние ----------
  // sessionStorage — живёт в пределах вкладки, переживает переходы по шагам формы
  const SS = {
    get: (k) => sessionStorage.getItem('ck_' + k),
    set: (k, v) => sessionStorage.setItem('ck_' + k, v),
    del: (k) => sessionStorage.removeItem('ck_' + k),
  };
  // v9.0: понятие «чекер» (вкл/выкл) ушло из интерфейса. Две сущности (v9.3):
  // «Запустить проверку» — БЕСКОНЕЧНЫЙ цикл (on). Галочка форсажа (boost +
  // boostRun) подменяет его темп: ритм игнорируется, проверки каждые boostSec
  // сек. «Проверить сейчас» — РАЗОВАЯ проверка (once): ровно один цикл до
  // вердикта, цикл никогда не запускает (даже с галочкой). driving() = машина
  // активно ведёт проверки хоть одним из них.
  const rhythmOn = () => SS.get('on') === '1';
  const boostMode = () => SS.get('boost') === '1';
  const boostRun = () => boostMode() && (SS.get('boostRun') === '1' || rhythmOn());
  const onceMode = () => SS.get('once') === '1';
  const onceOnly = () => onceMode() && !rhythmOn() && !boostRun();
  const driving = () => (rhythmOn() && !boostMode()) || boostRun() || onceMode();
  const foundMode = () => SS.get('found') === '1' || CONFIG.FORCE_FOUND;

  // v9.4: браузерный перевод страницы (Chrome «перевести на русский»)
  // переписывает испанские надписи — скрипт перестаёт узнавать экраны
  // («no hay citas», кнопки по тексту) и кликает наугад, даже выключенный.
  // Переведённую страницу Chrome помечает классом translated-ltr/rtl на <html>.
  const pageTranslated = () =>
    document.documentElement.classList.contains('translated-ltr') ||
    document.documentElement.classList.contains('translated-rtl');

  // localStorage — журнал и счётчик блоков (общие для сайта)
  function readLog() {
    try { return JSON.parse(localStorage.getItem('ck_log') || '[]'); } catch (e) { return []; }
  }
  function recordResult(state, extra) {
    const log = readLog();
    const entry = { t: Date.now(), s: state, x: extra || undefined };
    log.push(entry);
    while (log.length > 300) log.shift();
    localStorage.setItem('ck_log', JSON.stringify(log));
    sendJournal(entry); // дублируем запись в файл через хелпер (полная история на диске)
    renderStats();
  }
  // служебные записи журнала — НЕ проверки, в счётчик «сегодня» не идут
  // (SLOTS_CAPTCHA/FINAL — продолжение уже посчитанной находки, не новая проверка)
  const META_STATES = ['CONFIG', 'RESUMED', 'CLAVE_NEEDED', 'CLAVE_AUTH_WAIT',
    'SLOTS_CAPTCHA', 'SLOTS_FOUND_FINAL', 'SLOTS_CONFIRMED', 'SITE_MAINTENANCE'];
  function todayCount() {
    const day = new Date().toDateString();
    return readLog().filter((e) =>
      new Date(e.t).toDateString() === day && !META_STATES.includes(e.s)).length;
  }
  function lastResult() {
    const log = readLog();
    return log.length ? log[log.length - 1] : null;
  }
  const getBlocks = () => parseInt(localStorage.getItem('ck_blocks') || '0', 10);
  const setBlocks = (n) => localStorage.setItem('ck_blocks', String(n));
  const getUnknowns = () => parseInt(localStorage.getItem('ck_unknowns') || '0', 10);
  const setUnknowns = (n) => localStorage.setItem('ck_unknowns', String(n));
  const getLastBlockAt = () => parseInt(localStorage.getItem('ck_lastBlockAt') || '0', 10);
  const setLastBlockAt = (t) => localStorage.setItem('ck_lastBlockAt', String(t));
  // «блоков» в строке статистики — блоки ЗА СЕГОДНЯ (v9.1). Прежний показатель
  // (ck_blocks) — это цепочка блоков подряд для бэкоффа: она обнуляется после
  // паузы blockDecayMin, поэтому при сотнях проверок статистика писала «0».
  // Журнал ck_log ограничен 300 записями и при форсаже вытесняет старое —
  // поэтому ведём отдельный дневной счётчик (ключ с датой, в полночь сам = 0).
  function todayBlocks() {
    try {
      const d = JSON.parse(localStorage.getItem('ck_blocksDay') || 'null');
      return d && d.day === new Date().toDateString() ? d.n : 0;
    } catch (e) { return 0; }
  }
  function bumpTodayBlocks() {
    const day = new Date().toDateString();
    let n = 1;
    try {
      const d = JSON.parse(localStorage.getItem('ck_blocksDay') || 'null');
      if (d && d.day === day) n = d.n + 1;
    } catch (e) {}
    localStorage.setItem('ck_blocksDay', JSON.stringify({ day: day, n: n }));
  }
  function resetErrors() { setBlocks(0); setUnknowns(0); SS.del('siteerr'); }
  // На успешной проверке гасим только сиюминутные ошибки (незнакомая страница,
  // ошибка сайта). Счётчик WAF-блоков НЕ трогаем: иначе один успех между банами
  // обнуляет его и backoff не растёт (баг до v7.10 — ты крутишься в блоках весь
  // час). Блоки обнуляются сами по времени: если с последнего прошло >blockDecayMin.
  function resetTransient() {
    setUnknowns(0); SS.del('siteerr');
    if (getBlocks() && Date.now() - getLastBlockAt() > CONFIG.blockDecayMin * 60000) setBlocks(0);
  }

  // ---------- скользящий лимит проверок (главная защита от WAF) ----------
  // ck_hits — метки времени последних обращений к сайту (проверка = 1 запись).
  // Держим ≤ maxPerWindow за windowMin минут (порог WAF по данным 22–23.07).
  const readHits = () => { try { return JSON.parse(localStorage.getItem('ck_hits') || '[]'); } catch (e) { return []; } };
  function recordHit() {
    const cut = Date.now() - RUN.windowMin * 60000;
    const hits = readHits().filter((t) => t > cut);
    hits.push(Date.now());
    localStorage.setItem('ck_hits', JSON.stringify(hits));
  }
  const hitsInWindow = () => { const cut = Date.now() - RUN.windowMin * 60000; return readHits().filter((t) => t > cut).length; };
  function oldestHitInWindow() {
    const cut = Date.now() - RUN.windowMin * 60000;
    const w = readHits().filter((t) => t > cut);
    return w.length ? Math.min.apply(null, w) : Date.now();
  }

  // Пошаговый режим ПЕРЕЖИВАЕТ перезагрузку (sessionStorage) — иначе скрипт
  // снова захватывал форму после ручного перехода на главную. Он замораживает
  // ритм (как и форсаж): авто-навигации нет, каждый экран — по кнопке.
  // v9.0: ✋-пауза («не трогай страницу») ушла — её роль играет пошаговый режим.
  const stepMode = () => SS.get('step') === '1';
  let forcingStep = false; // кнопка «Сделать шаг» пропускает паузы на один тик
  let stopped = false;
  let waiting = false; // чекер ждёт следующую проверку — автофилл-автомат молчит
  let wasTranslated = false; // v9.4: страница сейчас переведена (для heartbeat)

  // ---------- голосовые алерты ----------
  const FALLBACK_TEXT = {
    found:   ['Ситы пойманы, всё заполнено! Введи SMS-код и нажми Confirmar!', 'Appointments found and form filled! Enter the SMS code and click Confirmar!'],
    help:    ['Ситы есть, но нужна твоя помощь! Подойди к компьютеру!', 'Appointments available, your help is needed! Come to the computer!'],
    stopped: ['Проверка сит остановилась. Посмотри, когда будет минутка.', 'Appointment checker stopped. Please check when you have a moment.'],
    unknown: ['Проверка сит увидела незнакомую страницу и остановилась.', 'Appointment checker encountered an unknown page and stopped.'],
    clave:   ['Нужна авторизация Cl@ve — подтверди вход в приложении на телефоне.', 'Cl@ve authentication required — please confirm login.'],
    cert:    ['Подтверди сертификат в окне Chrome — выбери его и нажми ОК.', 'Please confirm your digital certificate in the Chrome dialog and click OK.'],
    test:    ['Проверка связи. Голос работает.', 'Voice check. Audio alerts are working.'],
  };

  function gmGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('no GM')); return; }
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: timeoutMs || 4000,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error('http ' + r.status))),
        onerror: () => reject(new Error('net')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function gmPost(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('no GM')); return; }
      GM_xmlhttpRequest({
        method: 'POST', url, data: body, timeout: timeoutMs || 4000,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error('http ' + r.status))),
        onerror: () => reject(new Error('net')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Пишем каждую запись журнала в файл через хелпер — чтобы полная история
  // проверок жила на диске (ИИ-сессии могут её читать для контекста), а не
  // только в localStorage вкладки. Хелпер есть только на macOS → на других ОС
  // не опрашиваем локальный сервер и сразу используем встроенный голос браузера.
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  function sendJournal(entry) {
    if (!isMac) return;
    try {
      const label = logLabelText(entry.s);
      const line = new Date(entry.t).toLocaleString('ru') + '\t' + label +
        (entry.x ? '\t' + entry.x : '');
      gmPost(CONFIG.alertServer + '/journal', line, 3000).catch(() => {});
    } catch (e) { /* журнал не критичен */ }
  }

  // ---------- «экраны»: снимки ключевых экранов хелперу (v7.30) ----------
  // После находки экраны меняются быстро, и по одному журналу не видно, что
  // на них было (эпизод 03.09 11:01: находка → капча → снова капча → срыв —
  // что там предлагалось?). На каждый ключевой экран отправляем хелперу текст
  // страницы: тот сохраняет его (и PNG-скриншот всего экрана, если у Terminal
  // есть право «Запись экрана») в snaps/ в папке проекта — ИИ-сессия читает
  // файлы и видит всю цепочку: что было доступно и где сгорели ситы.
  // Один снимок на kind за загрузку страницы (перезагрузка = новый экран,
  // он снимается заново — две капчи в 11:01:11 и 11:01:42 дадут два файла).
  const snapped = {};
  function snapOnce(kind, note) {
    if (!isMac || snapped[kind]) return;
    snapped[kind] = true;
    try {
      const text = (document.body ? document.body.innerText : '').trim().slice(0, 40000);
      const q = '/snap?kind=' + encodeURIComponent(kind) +
        '&url=' + encodeURIComponent(location.href.slice(0, 250)) +
        (note ? '&note=' + encodeURIComponent(String(note).slice(0, 200)) : '');
      gmPost(CONFIG.alertServer + q, text, 5000)
        .then(() => { helperOk = true; })
        .catch(() => { helperOk = false; });
    } catch (e) { /* снимок не критичен */ }
  }

  let helperOk = null; // null = не проверяли, true/false
  function pingHelper() {
    if (!isMac) return Promise.resolve(false);
    return gmGet(CONFIG.alertServer + '/ping', 2500)
      .then(() => { helperOk = true; renderStats(); return true; })
      .catch(() => { helperOk = false; renderStats(); return false; });
  }

  // Пульс сторожу: хелпер знает, когда должна быть следующая проверка,
  // и голосом зовёт человека, если чекер замолчал (вкладку заморозили/закрыли).
  function sendBeat() {
    if (!isMac) return;
    const on = driving() ? 1 : 0;
    const nextAt = parseInt(SS.get('nextAt') || '0', 10);
    const due = on ? (nextAt || (Date.now() + RUN.intervalMaxMin * 60000)) : 0;
    gmGet(CONFIG.alertServer + '/beat?on=' + on + '&due=' + due, 3000)
      .then(() => { helperOk = true; renderStats(); })
      .catch(() => { helperOk = false; renderStats(); });
  }

  function browserFallbackAlert(kind) {
    const pair = FALLBACK_TEXT[kind] || FALLBACK_TEXT.test;
    const text = Array.isArray(pair) ? L(pair[0], pair[1]) : pair;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = LANGUAGES[getLang()].ttsLang || 'en-US'; u.rate = 0.95; u.volume = 1;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
    try { // писк через WebAudio (может молчать без клика по вкладке — политика Chrome)
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.3;
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 700);
    } catch (e) {}
  }

  async function fireAlert(kind, msg) {
    if (!isMac) {
      if (kind !== 'error') browserFallbackAlert(kind);
      return;
    }
    const q = '/alert?kind=' + encodeURIComponent(kind) +
      (msg ? '&msg=' + encodeURIComponent(msg) : '');
    for (let i = 0; i < 3; i++) {
      try {
        await gmGet(CONFIG.alertServer + q, 5000);
        helperOk = true; renderStats(); return;
      } catch (e) { await new Promise((r) => setTimeout(r, 2000)); }
    }
    helperOk = false; renderStats();
    if (kind !== 'error') browserFallbackAlert(kind); // ошибки без хелпера не озвучиваем
  }

  let alertTimer = null;
  let titleTimer = null;
  let baseTitle = null;
  function startAlertLoop(kind) {
    if (alertTimer) return;
    fireAlert(kind);
    alertTimer = setInterval(() => fireAlert(kind), CONFIG.alertRepeatSec * 1000);
    baseTitle = document.title.replace(/^([✅⚠️🔔] )+/, '');
    let flip = false;
    titleTimer = setInterval(() => {
      document.title = (flip ? '🔔 ' : (kind === 'found' ? '✅ ' : '⚠️ ')) + baseTitle;
      flip = !flip;
    }, 900);
    if (imHereBtn) imHereBtn.style.display = 'block';
  }
  function stopAlertLoop() {
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    if (baseTitle !== null) { document.title = '✅ ' + baseTitle; baseTitle = null; }
    if (imHereBtn) imHereBtn.style.display = 'none';
  }

  // ---------- планировщик проверок ----------
  // Форсаж (v9.0): галочка «Форсаж» на панели (под «Запустить проверку») —
  // ускоренный ТЕМП бесконечного цикла: каждые boostSec секунд (интервал —
  // поле в настройках ритма), пока галочка стоит; ритм игнорируется.
  // «Проверить сейчас» форсаж не запускает — та всегда одна проверка.
  // Включается ТОЛЬКО руками: авто-форсажа после находки/срыва нет (после
  // срыва — отдельная настройка lostRetry*). Пока форсаж ведёт проверки,
  // ритмичная проверка стоит «на паузе из-за режима форсаж».
  const inHotHours = () => {
    const h = new Date().getHours();
    return (parseHotHours(RUN.hotHours) || []).some(([a, b]) => h >= a && h < b);
  };
  function jitteredDelayMs() {
    if (boostRun()) return RUN.boostSec * 1000 * (0.85 + Math.random() * 0.3);

    // ЖЁСТКИЙ ПОТОЛОК: не больше maxPerWindow проверок за скользящее окно
    // windowMin. Проверяется первым. Если бюджет исчерпан — ждём, пока самая
    // старая проверка выпадет из окна (+джиттер). Гарантирует «≤N за окно».
    if (hitsInWindow() >= RUN.maxPerWindow) {
      SS.set('lastGap', L('лимит окна', 'window limit'));
      const freeAt = oldestHitInWindow() + RUN.windowMin * 60000;
      const wait = freeAt - Date.now();
      return Math.max(wait, 30000) + Math.random() * 30000;
    }
    SS.del('lastGap');

    if (RUN.mode === 'hourly') return hourlyDelayMs();
    const hot = inHotHours();

    // Горячий час: проверки ВРАЗБРОС — случайный интервал (в среднем
    // ~maxPerWindow за окно). Не пары: лучше временнóе покрытие всплеска и
    // человечнее. Потолок выше держит суммарно ≤maxPerWindow за окно.
    if (hot) {
      const min = RUN.hotIntervalMinSec * 1000;
      const max = RUN.hotIntervalMaxSec * 1000;
      return min + Math.random() * (max - min);
    }
    // не горячий час — спокойный базовый интервал
    const min = RUN.intervalMinMin * 60000;
    const max = RUN.intervalMaxMin * 60000;
    return min + Math.random() * (max - min);
  }
  // Следующее место в серии «первые N минут часа». Уже завершённые проверки
  // считаются по ck_hits, поэтому первый ручной старт внутри окна входит в N.
  function hourlyDelayMs() {
    const now = Date.now();
    const start = new Date();
    start.setMinutes(0, 0, 0);
    const windowStart = start.getTime();
    const windowEnd = windowStart + RUN.hourlyWindowMin * 60000;
    const hits = readHits().filter((t) => t >= windowStart && t < windowEnd).length;
    if (now < windowEnd && hits < RUN.hourlyChecks) {
      const left = RUN.hourlyChecks - hits;
      const slice = (windowEnd - now) / left;
      // Вразброс, но оставляем время на остальные проверки этой серии.
      return Math.max(15000, Math.min(slice * (0.55 + Math.random() * 0.35), windowEnd - now - 5000));
    }
    const next = new Date(start); next.setHours(next.getHours() + 1);
    return next.getTime() - now + 15000 + Math.random() * 45000;
  }
  // если момент попадает вне активных часов — сдвинуть на ближайшее «утро» + джиттер
  // (пресет с 0/24 не сдвигает никогда: ночная работа разрешена)
  function clampToActiveHours(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    if (h >= RUN.activeFrom && h < RUN.activeTo) return ts;
    const next = new Date(d);
    if (h >= RUN.activeTo) next.setDate(next.getDate() + 1);
    next.setHours(RUN.activeFrom, 0, 0, 0);
    return next.getTime() + Math.random() * 10 * 60000;
  }
  function scheduleNext(delayMs, why) {
    // форсаж НЕ сдвигаем на «утро»: ночной форсаж = долбим сейчас
    const at = (boostRun() || RUN.mode === 'hourly')
      ? (Date.now() + delayMs) : clampToActiveHours(Date.now() + delayMs);
    SS.set('nextAt', String(at));
    SS.set('why', why || L('Сит нет', 'No slots'));
    waiting = true;
    status('⏳ ' + (why || L('Жду следующую проверку', 'Waiting for next check')), '#ffd27f');
  }
  // v9.4: «назад» во время отсчёта паузы. Chrome часто отдаёт прошлую страницу
  // из кэша (bfcache): без перезагрузки boot() не выполняется, и страница
  // продолжает жить со старым состоянием (waiting=false — проверка шла) — tick
  // начинал прокликивать форму посреди, например, 30-минутной паузы после
  // блока. Поэтому паузу сверяем не с флагом страницы, а с самим расписанием.
  function schedulePending() {
    return parseInt(SS.get('nextAt') || '0', 10) > Date.now();
  }
  function checkerStop(reason, alertKind) {
    // полная остановка (v9.0): ритм, форсаж и разовая проверка гасятся разом —
    // «Остановить проверку» должна делать вкладку тихой, чем бы она ни была занята
    SS.del('on'); SS.del('nextAt'); SS.del('once'); SS.del('boostRun');
    SS.del('deepFill'); // v9.5: маркер глубины не должен переживать стоп
    SS.del('clavePending'); // не тащить флаг Cl@ve в выключенное состояние (v7.27)
    localStorage.removeItem('ck_claveResume'); // не воскрешать проверку после ручного стопа
    waiting = false; stopped = true;
    stopAlertLoop(); // v9.23: «вкладка должна стать тихой» — глушим зов и отсюда,
                     // а не только из кнопки «Остановить проверку» (эпизод 29.09:
                     // после UNKNOWN-остановки кнопка уже предлагала «Запустить»,
                     // и выключить голосовой луп было нечем)
    status(reason, '#ff8888');
    renderStats();
    sendBeat(); // сказать сторожу «я выключен осознанно», чтобы он не звал зря
    if (alertKind) fireAlert(alertKind); // одно спокойное сообщение, без лупа
  }

  // Видимая ошибка страницы (нет опции офиса, нет услуги): не молчим и не
  // зацикливаемся — повтор через unknownRetryMin, три подряд = стоп с голосом.
  function softFail(code, why) {
    snapOnce('fail', code + ' ' + why); // видимая ошибка страницы — снимок для разбора
    if (!driving()) {
      status('⚠️ ' + why + L(' — посмотри страницу', ' — please check the page'), '#ffcc66');
      stopped = true;
      return;
    }
    // разовая проверка встретила препятствие — честно останавливаемся:
    // повтор через N минут никто не просил
    if (onceOnly()) { SS.del('once'); checkerStop('⚠️ ' + why + L(' — разовая проверка остановлена', ' — single check stopped')); return; }
    recordResult(code, currentTramite().key);
    const unknowns = getUnknowns() + 1;
    setUnknowns(unknowns);
    if (unknowns >= CONFIG.maxConsecutiveUnknown) {
      checkerStop('⚠️ ' + why + ' (' + unknowns + L(' раз подряд) — проверка остановлена', 'x in a row) — checker stopped'), 'unknown');
    } else {
      stopped = true;
      scheduleNext(CONFIG.unknownRetryMin * 60000, why + ' (#' + unknowns + ')');
      fireAlert('error', why + ' (#' + unknowns + '), ' + L('повтор через ', 'retry in ') + CONFIG.unknownRetryMin + L(' мин', ' min'));
    }
  }

  function startNewCheck() {
    const onForm = !!document.querySelector('#sede');
    const onProvince = !onForm && !!document.body &&
      /provincias disponibles/i.test(document.body.innerText);
    const verdict = onNoCitasVerdict(); // вердикт важнее потока: проверка уже закончена
    const onFork = !onForm && !onProvince && !verdict && hasClaveChoice();
    const onDatos = !onForm && !onProvince && !onFork && !verdict &&
      !!document.querySelector('#txtIdCitado, #txtTelefonoCitado');
    SS.del('deepFill'); // v9.5: новый цикл — глубина считается заново (ШАГ 3
                        // поставит флаг, если цикл опять дойдёт до заявителя)
    if (onForm || onProvince || onFork || onDatos) {
      // остаёмся: важно снять waiting/stopped, иначе tick останется заперт и
      // проверка не начнётся (nextAt кнопкой уже стёрт, таймеров больше нет).
      // Следующий тик (≤1 с) поведёт экран дальше по потоку.
      SS.del('viaVolver');
      waiting = false; stopped = false;
      status(onForm ? L('▶️ Проверяю прямо с этой формы…', '▶️ Checking directly from this form…')
        : onProvince ? L('▶️ Проверяю с экрана провинции…', '▶️ Checking from province selection…')
        : onFork ? L('▶️ Проверяю с развилки Cl@ve…', '▶️ Checking from Cl@ve choice…')
        : L('▶️ Продолжаю заполнение заявителя…', '▶️ Continuing applicant form…'));
      return;
    }
    if (driving() && !recently('volver', 4000) && verdict) {
      const v = findVolverBtn();
      if (v) {
        status(L('↩️ Возвращаюсь к поиску сит (Volver)…', '↩️ Returning to search (Volver)…'));
        SS.set('viaVolver', '1');
        SS.set('volverAt', String(Date.now()));
        SS.set('forceNow', '1'); // новая страница поведёт форму сразу, без ритма
        v.click();
        return;
      }
      // вердикт на экране, а кнопку не нашли — перезаход; в журнале будет ↪,
      // чтобы причина была видна без смотреть на экран
      SS.set('volverMiss', '1');
      status(L('↩️ Volver не нашёл на этом экране — перезаход страницей…', '↩️ Volver not found on this screen — reloading start page…'), '#ffd27f');
    }
    SS.del('viaVolver');
    SS.set('forceNow', '1'); // и после перезахода — вести форму без ожидания ритма
    location.replace(SS.get('startUrl') || DEFAULT_START);
  }

  // секундный пульс: обратный отсчёт и рестарт цикла.
  // Троттлинг фоновых вкладок (тик раз в минуту) не мешает: сравниваем с абсолютным временем.
  function heartbeat() {
    // v9.4: пока страница переведена — автомат молчит (tick тоже, см. там),
    // а строка статуса занята жёлтым «выключи перевод»: испанские надписи
    // скрипт всё равно не читает. Выключат перевод — статусы вернутся сами.
    if (pageTranslated()) {
      status(L('🌐 Перевод страницы включён — выключи его: скрипт читает испанские надписи', '🌐 Page translation is ON — turn it off (script reads Spanish labels)'), '#ffd27f');
      wasTranslated = true;
      return;
    }
    if (wasTranslated) {
      wasTranslated = false;
      status(L('🌐 Перевод выключен — снова вижу экраны сайта', '🌐 Page translation turned off — reading site screens again'), '#8fd498');
    }
    if (!driving()) return;
    const nextAt = parseInt(SS.get('nextAt') || '0', 10);
    if (!nextAt) return;
    if (stepMode()) return; // пошаговый замораживает ритм — не перезагружать самим
    const left = nextAt - Date.now();
    if (left <= 0) {
      // nextAt НЕ удаляем и waiting НЕ снимаем до реальной перезагрузки:
      // если Volver/replace не сработал (Chrome заморозил вкладку и т.п.) —
      // пробуем снова каждые 10 секунд, пока страница не перезагрузится.
      // Новая загрузка страницы сама очистит устаревший nextAt (см. boot).
      if (!recently('cycleReload', 10000)) {
        status(L('🔄 Начинаю следующую проверку…', '🔄 Starting next check…'));
        startNewCheck();
      }
      return;
    }
    if (left > 90 * 60000) {
      // долгая пауза (ночь) — показываем время, а не пугающий отсчёт
      const at = new Date(nextAt);
      const hhmm = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
      status(L('💤 Ночная пауза. Следующая проверка в ', '💤 Night pause. Next check at ') + hhmm, '#ffd27f');
      document.title = L('💤 до ', '💤 until ') + hhmm + ' — cita checker';
      return;
    }
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    const t = mm + ':' + String(ss).padStart(2, '0');
    status('⏳ ' + (SS.get('why') || L('Сит нет', 'No slots')) + L('. Следующая проверка через ', '. Next check in ') + t, '#ffd27f');
    document.title = '⏳ ' + t + ' — cita checker';
  }

  // ---------- панель (Dark Charcoal / Slate / Muted Teal Theme) ----------
  const THEME = {
    bgMain: '#171C20',
    bgSection: '#222A30',
    bgSectionHover: '#29333B',
    bgNested: '#1B2227',
    border: '#303B42',
    textPrimary: '#E5ECEE',
    textSecondary: '#9AA8AE',
    accent: '#39A58C',
    accentHover: '#42B59B',
    success: '#36A477',
    danger: '#D45F52',
    warning: '#D4A34F',
  };
  function mapThemeColor(c) {
    if (!c) return THEME.textPrimary;
    const low = String(c).toLowerCase();
    if (low === '#7cfc00' || low === '#27ae60') return THEME.success;
    if (low === '#ff8888' || low === '#a93226' || low === '#c0392b') return THEME.danger;
    if (low === '#ffcc66' || low === '#ffd27f' || low === '#e67e22' || low === '#b9770e') return THEME.warning;
    if (low === '#bbb' || low === '#999' || low === '#ccc') return THEME.textSecondary;
    if (low === '#2980b9' || low === '#16a085') return THEME.accent;
    return c;
  }
  function ensureThemeStyles() {
    if (document.getElementById('ck-theme-style')) return;
    const st = document.createElement('style');
    st.id = 'ck-theme-style';
    st.textContent = `
      #ck-panel-root {
        scrollbar-width: thin;
        scrollbar-color: ${THEME.border} ${THEME.bgMain};
      }
      #ck-panel-root::-webkit-scrollbar,
      #ck-panel-root *::-webkit-scrollbar { width: 6px; height: 6px; }
      #ck-panel-root::-webkit-scrollbar-track,
      #ck-panel-root *::-webkit-scrollbar-track { background: ${THEME.bgNested}; border-radius: 4px; }
      #ck-panel-root::-webkit-scrollbar-thumb,
      #ck-panel-root *::-webkit-scrollbar-thumb { background: ${THEME.border}; border-radius: 4px; }
      #ck-panel-root .ck-btn {
        width: 100%;
        padding: 7px 10px;
        border-radius: 6px;
        cursor: pointer;
        font: 600 12px/1.35 system-ui, -apple-system, sans-serif;
        color: ${THEME.textPrimary};
        margin-top: 6px;
        box-sizing: border-box;
        transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        text-align: center;
      }
      #ck-panel-root .ck-btn:focus-visible,
      #ck-panel-root .ck-acc-hdr:focus-visible,
      #ck-panel-root summary.ck-acc-hdr:focus-visible {
        outline: 2px solid ${THEME.accent};
        outline-offset: 1px;
      }
      #ck-panel-root .ck-btn-primary {
        background: ${THEME.accent};
        border: 1px solid ${THEME.accent};
        color: #fff;
      }
      #ck-panel-root .ck-btn-primary:hover:not(:disabled) {
        background: ${THEME.accentHover};
        border-color: ${THEME.accentHover};
      }
      #ck-panel-root .ck-btn-secondary {
        background: ${THEME.bgSection};
        border: 1px solid ${THEME.border};
        color: ${THEME.textPrimary};
      }
      #ck-panel-root .ck-btn-secondary:hover:not(:disabled) {
        background: ${THEME.bgSectionHover};
      }
      #ck-panel-root .ck-btn-danger {
        background: ${THEME.danger};
        border: 1px solid ${THEME.danger};
        color: #fff;
      }
      #ck-panel-root .ck-btn-danger:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      #ck-panel-root .ck-btn-success {
        background: ${THEME.success};
        border: 1px solid ${THEME.success};
        color: #fff;
      }
      #ck-panel-root .ck-btn-success:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      #ck-panel-root .ck-acc-hdr {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        margin-top: 6px;
        background: ${THEME.bgSection};
        border: 1px solid ${THEME.border};
        border-radius: 6px;
        color: ${THEME.textPrimary};
        font: 600 12px/1.35 system-ui, -apple-system, sans-serif;
        cursor: pointer;
        box-sizing: border-box;
        user-select: none;
        text-align: left;
        transition: background 0.15s ease, border-radius 0.15s ease, border-color 0.15s ease;
      }
      #ck-panel-root .ck-acc-hdr:hover {
        background: ${THEME.bgSectionHover};
      }
      #ck-panel-root .ck-acc-hdr[aria-expanded="true"],
      #ck-panel-root details[open] > summary.ck-acc-hdr {
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
        border-bottom-color: ${THEME.border};
        background: ${THEME.bgSectionHover};
      }
      #ck-panel-root .ck-acc-chev {
        font-size: 11px;
        color: ${THEME.textSecondary};
        transition: transform 0.18s ease;
        display: inline-block;
        flex: none;
      }
      #ck-panel-root .ck-acc-hdr[aria-expanded="true"] .ck-acc-chev,
      #ck-panel-root details[open] > summary.ck-acc-hdr .ck-acc-chev {
        transform: rotate(90deg);
        color: ${THEME.textPrimary};
      }
      #ck-panel-root .ck-acc-body {
        background: ${THEME.bgNested};
        border: 1px solid ${THEME.border};
        border-top: 0;
        border-bottom-left-radius: 6px;
        border-bottom-right-radius: 6px;
        padding: 8px 10px 10px;
        margin-top: 0;
        box-sizing: border-box;
        animation: ckAccFadeIn 0.14s ease-out;
      }
      #ck-panel-root summary.ck-acc-hdr::-webkit-details-marker { display: none; }
      #ck-panel-root summary.ck-acc-hdr { list-style: none; }
      #ck-panel-root .ck-seg {
        display: flex;
        gap: 4px;
        padding: 3px;
        margin-top: 8px;
        background: ${THEME.bgNested};
        border: 1px solid ${THEME.border};
        border-radius: 7px;
        box-sizing: border-box;
      }
      #ck-panel-root .ck-seg-chip {
        flex: 1;
        padding: 5px 8px;
        border: 1px solid transparent;
        border-radius: 5px;
        background: transparent;
        color: ${THEME.textSecondary};
        font: 600 11.5px/1.3 system-ui, -apple-system, sans-serif;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        text-align: center;
      }
      #ck-panel-root .ck-seg-chip:hover {
        color: ${THEME.textPrimary};
      }
      #ck-panel-root .ck-seg-chip.ck-active-rhythm {
        background: ${THEME.bgSection};
        border-color: ${THEME.accent};
        color: ${THEME.textPrimary};
      }
      #ck-panel-root .ck-seg-chip.ck-active-boost {
        background: ${THEME.bgSection};
        border-color: ${THEME.warning};
        color: ${THEME.warning};
      }
      #ck-panel-root input[type="checkbox"],
      #ck-panel-root input[type="radio"] {
        accent-color: ${THEME.accent};
      }
      @keyframes ckAccFadeIn {
        from { opacity: 0; transform: translateY(-2px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  let stateEl = null, statusEl = null, statsEl = null, settingsLineEl = null;
  let runBtn = null, boostCapEl = null, boostLabelEl = null;
  let rhythmChipEl = null, boostChipEl = null, rhythmAccHdr = null, boostAccHdr = null;
  let rhythmFormRef = null, boostFormRef = null, setFormOpenFn = null;
  let stepToggle = null, stepGoBtn = null, imHereBtn = null;
  function status(msg, color) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = mapThemeColor(color); }
  }
  function rhythmRateShort() {
    if (RUN.mode === 'hourly') {
      return L(RUN.hourlyChecks + '×/' + RUN.hourlyWindowMin + 'м', RUN.hourlyChecks + '×/' + RUN.hourlyWindowMin + 'm');
    }
    return formatIntervalRange(RUN.intervalMinMin, RUN.intervalMaxMin) + L('м', 'm');
  }
  function paceLineSummary() {
    if (boostMode()) {
      return L('Форсаж: каждые ' + RUN.boostSec + ' сек', 'Boost: every ' + RUN.boostSec + 's');
    }
    if (RUN.mode === 'hourly') {
      return L(
        'Ритм: ' + RUN.hourlyChecks + '× в первые ' + RUN.hourlyWindowMin + ' мин/ч',
        'Pace: ' + RUN.hourlyChecks + '× in first ' + RUN.hourlyWindowMin + 'm/hr'
      );
    }
    const r = formatIntervalRange(RUN.intervalMinMin, RUN.intervalMaxMin);
    const hot = String(RUN.hotHours || '').trim()
      ? L(' (пик ' + formatIntervalRange(RUN.hotIntervalMinSec, RUN.hotIntervalMaxSec) + 'с)', ' (peak ' + formatIntervalRange(RUN.hotIntervalMinSec, RUN.hotIntervalMaxSec) + 's)')
      : '';
    return L('Ритм: каждые ' + r + ' мин' + hot, 'Pace: every ' + r + ' min' + hot);
  }
  // строка режима (●): v9.2 — живёт в секции «Ритмичная проверка», рядом с
  // кнопкой старт/стоп; наверху панели осталась только строка активности
  function renderState() {
    const isBoost = boostMode();
    const paceTxt = paceLineSummary();
    if (stateEl) {
      let txt, color;
      if (foundMode()) { txt = L('● СИТЫ НАЙДЕНЫ — доделываем вместе', '● SLOTS FOUND — finishing together'); color = THEME.success; }
      else if (stepMode()) { txt = L('● Пошаговый режим — ритм заморожен', '● Step-by-step mode — rhythm paused'); color = THEME.warning; }
      else if (boostRun()) { txt = L('● Идёт проверка · ', '● Running · ') + paceTxt; color = THEME.warning; }
      else if (rhythmOn()) { txt = L('● Идёт проверка · ', '● Running · ') + paceTxt; color = THEME.success; }
      else if (onceMode()) { txt = L('● Разовая проверка… · ', '● Single check… · ') + paceTxt; color = THEME.accent; }
      else { txt = L('● Выкл · ', '● OFF · ') + paceTxt; color = THEME.textSecondary; }
      stateEl.textContent = txt;
      stateEl.style.color = color;
    }
    if (runBtn) {
      const on = rhythmOn() || boostRun(); // v9.3: стоп виден и когда цикл идёт форсажным темпом
      runBtn.textContent = on ? L('Остановить проверку', 'Stop Checking') : L('Запустить проверку', 'Start Checking');
      runBtn.className = 'ck-btn ' + (on ? 'ck-btn-danger' : 'ck-btn-primary');
    }
    if (rhythmChipEl && boostChipEl) {
      rhythmChipEl.className = 'ck-seg-chip' + (!isBoost ? ' ck-active-rhythm' : '');
      boostChipEl.className = 'ck-seg-chip' + (isBoost ? ' ck-active-boost' : '');
      rhythmChipEl.setAttribute('aria-pressed', !isBoost ? 'true' : 'false');
      boostChipEl.setAttribute('aria-pressed', isBoost ? 'true' : 'false');
      rhythmChipEl.textContent = L('⏱ Ритм (', '⏱ Rhythm (') + rhythmRateShort() + ')';
      boostChipEl.textContent = L('⚡ Форсаж (' + RUN.boostSec + 'с)', '⚡ Boost (' + RUN.boostSec + 's)');
    }
    if (rhythmAccHdr && boostAccHdr) {
      rhythmAccHdr.style.display = !isBoost ? 'flex' : 'none';
      boostAccHdr.style.display = isBoost ? 'flex' : 'none';
      if (isBoost && rhythmFormRef && rhythmFormRef.style.display !== 'none' && setFormOpenFn) {
        setFormOpenFn(rhythmFormRef, false);
      } else if (!isBoost && boostFormRef && boostFormRef.style.display !== 'none' && setFormOpenFn) {
        setFormOpenFn(boostFormRef, false);
      }
    }
    if (boostCapEl) boostCapEl.style.display = (rhythmOn() && isBoost) ? 'block' : 'none';
    if (stepToggle) {
      const s = stepMode();
      stepToggle.textContent = s ? L('Выключить пошаговый режим', 'Disable Step-by-Step Mode') : L('Включить пошаговый режим', 'Enable Step-by-Step Mode');
      stepToggle.className = 'ck-btn ' + (s ? 'ck-btn-danger' : 'ck-btn-secondary');
      if (stepGoBtn) stepGoBtn.style.display = s ? 'block' : 'none';
    }
  }
  function renderStats() {
    if (statsEl) {
      const last = lastResult();
      const lastTxt = last
        ? new Date(last.t).toTimeString().slice(0, 5) + ' ' + logLabelText(last.s)
        : '—';
      statsEl.textContent =
        L('сегодня: ', 'today: ') + todayCount() + L(' (блоков: ', ' (blocks: ') + todayBlocks() + L(') | последняя: ', ') | last: ') + lastTxt;
    }
    if (settingsLineEl) {
      const helper = helperOk === null ? '⚪️' : helperOk ? '🟢' : '🔴';
      // v9.2: без офиса (выбран селектором выше), без версии (переехала в
      // приписку внизу) и без «форсаж» (виден строкой режима и галочкой)
      settingsLineEl.textContent = settingsSummary(false) + L(' · голос: ', ' · voice: ') + helper;
    }
    renderState();
  }
  // mkBtn создаёт настоящие кнопки действий с единой палитрой:
  // primary (#39A58C), success (#36A477), danger (#D45F52) или secondary (#222A30).
  function mkBtn(label, bg) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    const low = String(bg || '').toLowerCase();
    let variant = 'ck-btn-secondary';
    if (low === '#39a58c' || low === 'primary') variant = 'ck-btn-primary';
    else if (low === '#27ae60' || low === '#36a477' || low === 'success') variant = 'ck-btn-success';
    else if (low === '#c0392b' || low === '#a93226' || low === '#d45f52' || low === 'danger') variant = 'ck-btn-danger';
    b.className = 'ck-btn ' + variant;
    return b;
  }
  // v9.3: гашение кнопок сохранения — активны, только когда есть что сохранить
  // (изменила значения / ввела имя). off=true: полупрозрачная и не кликается.
  function setDim(btn, off) {
    btn.disabled = off;
    btn.style.opacity = off ? '.45' : '1';
    btn.style.cursor = off ? 'default' : 'pointer';
  }
  // Общий стиль чекбокс-строк панели (label). CSS сайта стилизует тег label
  // под свои формы (сжимает по ширине) — панель живёт внутри той же страницы,
  // поэтому глушим чужую ширину и ставим свою: строка на всю ширину панели.
  const checkRowCss = 'display:flex;gap:7px;align-items:flex-start;margin-top:5px;' +
    'font-size:11.5px;line-height:1.35;cursor:pointer;color:' + THEME.textPrimary + ';' +
    'width:100%;max-width:none;float:none;box-sizing:border-box';
  function panel() {
    ensureThemeStyles();
    const old = document.getElementById('ck-panel-root');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'ck-panel-root';
    box.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:2147483647;background:' + THEME.bgMain + ';color:' + THEME.textPrimary + ';' +
      'font:12.5px/1.45 system-ui,-apple-system,sans-serif;padding:12px 14px;border-radius:10px;' +
      'border:1px solid ' + THEME.border + ';box-shadow:0 8px 24px rgba(0,0,0,.55);width:356px;max-width:calc(100vw - 20px);' +
      'max-height:92vh;overflow-y:auto;box-sizing:border-box';

    // Переключатель языка (EN по умолчанию, RU и др. из LANGUAGES)
    const langBar = document.createElement('div');
    langBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
      'margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid ' + THEME.border + ';font-size:11px;color:' + THEME.textSecondary;
    const langLabel = document.createElement('span');
    langLabel.style.cssText = 'font-weight:600;color:' + THEME.textPrimary + ';letter-spacing:0.2px';
    langLabel.textContent = 'Cita Por Favor';
    const langRight = document.createElement('div');
    langRight.style.cssText = 'display:flex;align-items:center;gap:5px';
    const langIcon = document.createElement('span');
    langIcon.textContent = '🌐';
    const langSel = document.createElement('select');
    langSel.style.cssText = 'padding:2px 6px;border:1px solid ' + THEME.border + ';border-radius:5px;' +
      'background:' + THEME.bgSection + ';color:' + THEME.textPrimary + ';font:11px system-ui,sans-serif;cursor:pointer';
    for (const [code, info] of Object.entries(LANGUAGES)) {
      const op = document.createElement('option');
      op.value = code;
      op.textContent = info.label;
      if (code === getLang()) op.selected = true;
      langSel.appendChild(op);
    }
    langSel.onchange = () => {
      DATA.lang = langSel.value;
      persistData();
      box.remove();
      panel();
      if (!driving() && !foundMode()) {
        if (document.querySelector('#sede')) {
          status(L('📡 Проверка выключена — страницу не трогаю', '📡 Checker is OFF — leaving page untouched'), THEME.textSecondary);
        } else if (onNoCitasVerdict()) {
          status(L('🔁 Сейчас сит нет — жми «Проверить сейчас» или запусти ритм', '🔁 No slots right now — click "Check Now" or "Start Checking"'), THEME.warning);
        }
      }
      heartbeat();
    };
    langRight.appendChild(langIcon);
    langRight.appendChild(langSel);
    langBar.appendChild(langLabel);
    langBar.appendChild(langRight);
    box.appendChild(langBar);

    // Карточка статуса (Status Information)
    const statusCard = document.createElement('div');
    statusCard.style.cssText = 'background:' + THEME.bgSection + ';border:1px solid ' + THEME.border + ';' +
      'border-radius:7px;padding:8px 10px;margin-bottom:4px';
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:3px;color:' + THEME.textPrimary;
    statusCard.appendChild(statusEl);
    statsEl = document.createElement('div');
    statsEl.style.cssText = 'font-size:11px;color:' + THEME.textSecondary + ';white-space:pre-line';
    statusCard.appendChild(statsEl);
    box.appendChild(statusCard);

    // заголовок секции панели (макет: небольшая прописная подпись с приглушённым цветом)
    function sectionTitle(text) {
      const d = document.createElement('div');
      d.style.cssText = 'margin-top:12px;margin-bottom:4px;padding-top:8px;border-top:1px solid ' + THEME.border + ';' +
        'font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + THEME.textSecondary;
      d.textContent = text;
      return d;
    }

    // сворачиваемые разделы (аккордеон): открыт один — остальные закрыты,
    // синхронизируем aria-expanded и поворот шеврона.
    const collapsibles = [];
    function setFormOpen(form, open) {
      form.style.display = open ? 'block' : 'none';
      if (form._hdr) form._hdr.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function openOnly(form) {
      for (const f of collapsibles) setFormOpen(f, false);
      if (form) setFormOpen(form, true);
    }
    function toggleSettings(form) {
      const wasOpen = form.style.display !== 'none';
      openOnly(null);
      if (!wasOpen) setFormOpen(form, true);
    }
    function mkAccordionHeader(icon, labelText, form, onBeforeToggle) {
      const hdr = document.createElement('button');
      hdr.type = 'button';
      hdr.className = 'ck-acc-hdr';
      hdr.setAttribute('aria-expanded', 'false');
      const left = document.createElement('span');
      left.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0';
      const ic = document.createElement('span');
      ic.style.cssText = 'font-size:12px;flex:none;opacity:.9';
      ic.textContent = icon;
      const tx = document.createElement('span');
      tx.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      tx.textContent = labelText;
      left.appendChild(ic);
      left.appendChild(tx);
      const chev = document.createElement('span');
      chev.className = 'ck-acc-chev';
      chev.textContent = '▸';
      hdr.appendChild(left);
      hdr.appendChild(chev);
      form._hdr = hdr;
      hdr.onclick = () => {
        if (onBeforeToggle) onBeforeToggle();
        toggleSettings(form);
      };
      return hdr;
    }

    // v9.2 (аккордеон): каждая форма живёт сразу под СВОИМ заголовком аккордеона.
    const settingsForm = document.createElement('div'); // «Мои данные»
    const searchForm = document.createElement('div');   // «Настройки поиска»
    const rhythmForm = document.createElement('div');   // «Настроить ритм»
    const boostForm = document.createElement('div');    // «Настройки форсажа»
    for (const f of [settingsForm, searchForm, rhythmForm, boostForm]) {
      f.className = 'ck-acc-body';
      f.style.display = 'none';
    }
    // разделитель внутри формы
    function formDivider() {
      const d = document.createElement('div');
      d.style.cssText = 'border-top:1px solid ' + THEME.border + ';margin-top:8px;padding-top:2px';
      return d;
    }

    // ---- секция «Офисы, которые проверяем» ----
    box.appendChild(sectionTitle(L('Офисы, которые проверяем', 'Office Selection')));

    const OFFICE_ROWS = OFFICES.filter((o) => o.key);
    const officeDetails = document.createElement('details');
    officeDetails.style.cssText = 'margin-top:4px;font:12px system-ui,sans-serif';
    const officeSummary = document.createElement('summary');
    officeSummary.className = 'ck-acc-hdr';
    officeSummary.style.marginTop = '0';
    const officeSummaryLeft = document.createElement('span');
    officeSummaryLeft.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0';
    const officeSummaryIcon = document.createElement('span');
    officeSummaryIcon.style.cssText = 'font-size:12px;flex:none';
    officeSummaryIcon.textContent = '📍';
    const officeSummaryText = document.createElement('span');
    officeSummaryText.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    officeSummaryText.textContent = officesModeShort();
    officeSummaryLeft.appendChild(officeSummaryIcon);
    officeSummaryLeft.appendChild(officeSummaryText);
    const officeSummaryChev = document.createElement('span');
    officeSummaryChev.className = 'ck-acc-chev';
    officeSummaryChev.textContent = '▸';
    officeSummary.appendChild(officeSummaryLeft);
    officeSummary.appendChild(officeSummaryChev);
    officeDetails.appendChild(officeSummary);

    const officeBody = document.createElement('div');
    officeBody.className = 'ck-acc-body';
    const officeToggles = document.createElement('div');
    officeToggles.style.cssText = 'margin-top:2px;font-size:11px';
    const allLinkCss = 'color:' + THEME.accent + ';cursor:pointer;text-decoration:underline;margin-right:12px;font-weight:600';
    const officeAllLink = document.createElement('span');
    officeAllLink.textContent = L('Выбрать все', 'Select all');
    officeAllLink.style.cssText = allLinkCss;
    const officeNoneLink = document.createElement('span');
    officeNoneLink.textContent = L('Снять все', 'Clear all');
    officeNoneLink.style.cssText = allLinkCss;
    officeToggles.appendChild(officeAllLink);
    officeToggles.appendChild(officeNoneLink);
    officeBody.appendChild(officeToggles);

    const officeList = document.createElement('div');
    officeList.style.cssText = 'margin-top:6px;max-height:220px;overflow-y:auto;' +
      'border:1px solid ' + THEME.border + ';border-radius:5px;padding:4px 8px;background:' + THEME.bgMain;
    const officeChecks = {};
    for (const o of OFFICE_ROWS) {
      const row = document.createElement('label');
      row.style.cssText = checkRowCss;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = DATA.offices.includes(o.key);
      cb.style.cssText = 'margin:1px 0 0';
      officeChecks[o.key] = cb;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(o.label));
      officeList.appendChild(row);
    }
    officeBody.appendChild(officeList);

    const officeHint = document.createElement('div');
    officeHint.style.cssText = 'margin-top:6px;font-size:10.5px;line-height:1.35;color:' + THEME.textSecondary;
    officeHint.textContent = officesModeHint();
    officeBody.appendChild(officeHint);

    // галка «брать любой»: видна только при 2+ отмеченных (см.
    // officeAnyEffective) — в остальных режимах она не нужна и не действует
    const anyRow = document.createElement('label');
    anyRow.style.cssText = checkRowCss + ';margin-top:6px';
    const anyCb = document.createElement('input');
    anyCb.type = 'checkbox';
    anyCb.checked = !!DATA.officeAny;
    anyCb.style.cssText = 'margin:1px 0 0';
    anyRow.appendChild(anyCb);
    anyRow.appendChild(document.createTextNode(L('Если выбранных офисов нет — брать любой', 'If selected offices have no slots — take any')));
    officeBody.appendChild(anyRow);
    officeDetails.appendChild(officeBody);
    function renderAnyRow() {
      anyRow.style.display = selectedOffices().length >= 2 ? 'flex' : 'none';
    }
    renderAnyRow();

    function applyOfficeSelection() {
      DATA.offices = OFFICE_ROWS.filter((o) => officeChecks[o.key].checked).map((o) => o.key);
      DATA.officeAny = anyCb.checked;
      persistData();
      SS.del('tramIdx'); // начать чередование услуг заново
      officeSummaryText.textContent = officesModeShort();
      officeHint.textContent = officesModeHint();
      renderAnyRow();
      status('🏥 ' + officesModeStatus(), THEME.success);
      renderStats();
    }
    for (const o of OFFICE_ROWS) officeChecks[o.key].addEventListener('change', applyOfficeSelection);
    anyCb.addEventListener('change', applyOfficeSelection);
    officeAllLink.onclick = () => {
      for (const o of OFFICE_ROWS) officeChecks[o.key].checked = true;
      applyOfficeSelection();
    };
    officeNoneLink.onclick = () => {
      for (const o of OFFICE_ROWS) officeChecks[o.key].checked = false;
      applyOfficeSelection();
    };
    box.appendChild(officeDetails);

    // ---- секция «Ритмичная проверка» (Automatic Checking) ----
    box.appendChild(sectionTitle(L('Ритмичная проверка', 'Automatic Checking')));
    stateEl = document.createElement('div');
    stateEl.style.cssText = 'font-size:11.5px;font-weight:600;margin-top:2px;margin-bottom:2px';
    box.appendChild(stateEl);

    runBtn = mkBtn(L('Запустить проверку', 'Start Checking'), 'primary');
    runBtn.onclick = () => {
      // v9.3: останавливает ЛЮБОЙ бесконечный цикл — ритм или форсаж
      if (rhythmOn() || boostRun()) {
        checkerStop(L('⏹ Проверка остановлена', '⏹ Checking stopped')); // полная тишина: ритм, форсаж, разовая
        stopAlertLoop();
      } else if (!dataReady()) {
        status(L('⚙️ Сначала заполни свои данные', '⚙️ Please fill in your personal details first'), THEME.warning);
        openOnly(settingsForm);
      } else {
        const start = /\/citar\?p=/.test(location.href) ? location.href : DEFAULT_START;
        SS.set('on', '1'); SS.set('startUrl', start);
        SS.del('nextAt'); SS.del('found'); SS.del('once');
        SS.del('step');
        if (boostMode()) SS.set('boostRun', '1'); // галочка стоит — старт сразу в форсаже
        resetErrors();
        // версия в записи CONFIG — по журналу видно, какая версия работала в отрезок
        recordResult('CONFIG', 'v' + SCRIPT_VER + ' · ' + settingsSummary());
        location.replace(start); // чистый старт цикла
      }
      renderStats();
    };
    box.appendChild(runBtn);

    // «Проверить сейчас» (разовая проверка — вторичная кнопка рядом с запуском цикла)
    const nowBtn = mkBtn(L('Проверить сейчас', 'Check Now (Single Check)'), 'secondary');
    nowBtn.onclick = () => {
      if (!dataReady()) {
        status(L('⚙️ Сначала заполни свои данные', '⚙️ Please fill in your personal details first'), THEME.warning);
        openOnly(settingsForm);
        return;
      }
      const start = SS.get('startUrl') ||
        (/\/citar\?p=/.test(location.href) ? location.href : DEFAULT_START);
      SS.set('startUrl', start);
      SS.del('nextAt'); SS.del('found');
      SS.del('step');
      waiting = false; stopped = false;
      if (rhythmOn() || boostRun()) SS.del('once');
      else SS.set('once', '1'); // ничего не идёт: ровно один цикл до вердикта
      renderState();
      startNewCheck();
    };
    box.appendChild(nowBtn);

    // Переключатель темпа (2 чипа: «⏱ Ритм» | «⚡ Форсаж»).
    // Показываем аккордеон настроек ТОЛЬКО для выбранного режима.
    const modeSeg = document.createElement('div');
    modeSeg.className = 'ck-seg';
    rhythmChipEl = document.createElement('button');
    rhythmChipEl.type = 'button';
    rhythmChipEl.textContent = L('⏱ По ритму', '⏱ Rhythm');
    boostChipEl = document.createElement('button');
    boostChipEl.type = 'button';
    boostChipEl.textContent = L('⚡ Форсаж (' + RUN.boostSec + 'с)', '⚡ Boost (' + RUN.boostSec + 's)');
    function selectPaceMode(enableBoost) {
      if (enableBoost === boostMode()) return;
      if (enableBoost) {
        SS.set('boost', '1');
        if (rhythmOn()) { // ритм шёл — переключаем его темп на форсаж сразу
          SS.set('boostRun', '1');
          SS.del('nextAt');
          waiting = false; stopped = false;
          status(L('🔥 Форсаж: проверяю каждые ' + RUN.boostSec + ' сек (ритм на паузе)', '🔥 Boost: checking every ' + RUN.boostSec + ' sec (rhythm paused)'), THEME.warning);
        } else {
          status(L('🔥 Форсаж: каждые ' + RUN.boostSec + ' сек — так будет ходить «Запустить проверку»', '🔥 Boost: every ' + RUN.boostSec + ' sec — will apply to "Start Checking"'), THEME.warning);
        }
      } else {
        SS.del('boost'); SS.del('boostRun');
        if (rhythmOn() && (waiting || stopped)) // ритм возвращается к своему темпу
          scheduleNext(jitteredDelayMs(), L('Ритм возобновлён', 'Rhythm resumed'));
        else
          status(L('⏱ Режим: обычный ритм проверки', '⏱ Mode: normal check rhythm'), THEME.textSecondary);
      }
      renderState();
    }
    rhythmChipEl.onclick = () => selectPaceMode(false);
    boostChipEl.onclick = () => selectPaceMode(true);
    modeSeg.appendChild(rhythmChipEl);
    modeSeg.appendChild(boostChipEl);
    box.appendChild(modeSeg);

    // подпись: ритм формально идёт, но его темп подменён форсажем
    boostCapEl = document.createElement('div');
    boostCapEl.style.cssText = 'display:none;margin-top:4px;font-size:11px;color:' + THEME.warning;
    boostCapEl.textContent = L('Ритмичная проверка на паузе из-за режима форсаж', 'Normal rhythm is paused while Boost mode is active');
    box.appendChild(boostCapEl);

    setFormOpenFn = setFormOpen;
    rhythmFormRef = rhythmForm;
    boostFormRef = boostForm;

    const boostOpenBtn = mkAccordionHeader('⚡', L('Настройки форсажа', 'Boost Settings'), boostForm);
    boostAccHdr = boostOpenBtn;
    box.appendChild(boostOpenBtn);
    box.appendChild(boostForm);

    const rhythmOpenBtn = mkAccordionHeader('⏱', L('Настроить ритм проверки', 'Configure Check Rhythm'), rhythmForm, () => fillRhythmInputs());
    rhythmAccHdr = rhythmOpenBtn;
    box.appendChild(rhythmOpenBtn);
    box.appendChild(rhythmForm);

    // ---- секция «Общие настройки» (General Settings) ----
    box.appendChild(sectionTitle(L('Общие настройки', 'General Settings')));
    settingsLineEl = document.createElement('div');
    settingsLineEl.style.cssText = 'font-size:11px;color:' + THEME.textSecondary + ';margin-bottom:2px;white-space:pre-line';
    box.appendChild(settingsLineEl);

    const searchBtn = mkAccordionHeader('🔍', L('Изменить настройки поиска', 'Edit Search Settings'), searchForm);
    box.appendChild(searchBtn);
    box.appendChild(searchForm);
    const dataBtn = mkAccordionHeader('👤', L('Изменить мои данные', 'Edit My Personal Details'), settingsForm);
    box.appendChild(dataBtn);
    box.appendChild(settingsForm);

    // ---- секция «Утилиты и диагностика» (сворачиваемый блок) ----
    box.appendChild(sectionTitle(L('Инструменты и диагностика', 'Utilities & Diagnostics')));

    // Кнопки экстренного/активного действия («Следующий шаг» при пошаговом и «Я тут»)
    // держим снаружи сворачиваемого блока, чтобы они всегда были видны, когда активны.
    stepGoBtn = mkBtn(L('Следующий шаг', 'Next Step'), 'primary');
    stepGoBtn.onclick = () => {
      stopped = false; waiting = false;
      const nextAt = parseInt(SS.get('nextAt') || '0', 10);
      if (nextAt) { SS.del('nextAt'); startNewCheck(); return; }
      if (fillStepQueue && fillStepQueue.length) {
        fillStepQueue.shift()();
        status(fillStepQueue.length
          ? L('👣 Шаг сделан — ещё ' + fillStepQueue.length + ' (жми «Следующий шаг»)', '👣 Step done — ' + fillStepQueue.length + ' left (click "Next Step")')
          : L('👣 Последний шаг заполнения', '👣 Final filling step done'), THEME.warning);
        return;
      }
      forcingStep = true;
      try { tick(); } finally { forcingStep = false; }
    };
    box.appendChild(stepGoBtn);

    const utilDetails = document.createElement('details');
    utilDetails.style.cssText = 'margin-top:4px;font:12px system-ui,sans-serif';
    if (stepMode()) utilDetails.open = true;
    const utilSummary = document.createElement('summary');
    utilSummary.className = 'ck-acc-hdr';
    utilSummary.style.marginTop = '0';
    const utilSummaryLeft = document.createElement('span');
    utilSummaryLeft.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0';
    const utilSummaryIcon = document.createElement('span');
    utilSummaryIcon.style.cssText = 'font-size:12px;flex:none';
    utilSummaryIcon.textContent = '🛠';
    const utilSummaryText = document.createElement('span');
    utilSummaryText.textContent = L('Открыть инструменты и журнал', 'Tools, Voice Test & Check Log');
    utilSummaryLeft.appendChild(utilSummaryIcon);
    utilSummaryLeft.appendChild(utilSummaryText);
    const utilSummaryChev = document.createElement('span');
    utilSummaryChev.className = 'ck-acc-chev';
    utilSummaryChev.textContent = '▸';
    utilSummary.appendChild(utilSummaryLeft);
    utilSummary.appendChild(utilSummaryChev);
    utilDetails.appendChild(utilSummary);

    const utilBody = document.createElement('div');
    utilBody.className = 'ck-acc-body';

    // Пошаговый режим (замораживает ритм, как форсаж)
    stepToggle = mkBtn(L('Включить пошаговый режим', 'Enable Step-by-Step Mode'), 'secondary');
    stepToggle.style.marginTop = '2px';
    stepToggle.onclick = () => {
      if (stepMode()) { SS.del('step'); fillStepQueue = null; } // выход из пошагового — очередь не нужна
      else { SS.set('step', '1'); status(L('👣 Пошагово: ритм заморожен — жми «Следующий шаг»', '👣 Step-by-step: rhythm paused — click "Next Step"'), THEME.warning); }
      renderState();
    };
    utilBody.appendChild(stepToggle);

    // На страницу выбора офиса: смена офиса/услуги руками
    const firstBtn = mkBtn(L('Перейти на страницу выбора офиса', 'Go to Office Selection Page'), 'secondary');
    firstBtn.onclick = () => {
      location.replace(SS.get('startUrl') || DEFAULT_START);
    };
    utilBody.appendChild(firstBtn);

    const testBtn = mkBtn(L('Проверить голосовое оповещение', 'Test Voice Alert'), 'secondary');
    testBtn.onclick = () => fireAlert('test');
    utilBody.appendChild(testBtn);

    // ---- «Мои данные» и «Настройки поиска»: два раздела (v7.31) ----
    // Поле с подписью: label над input'ом, оба на всю ширину панели
    const inputCss = 'width:100%;margin-top:4px;padding:5px 7px;border:1px solid ' + THEME.border + ';' +
      'border-radius:5px;background:' + THEME.bgMain + ';color:' + THEME.textPrimary + ';font:12px system-ui,sans-serif;box-sizing:border-box';
    function mkField(form, labelText, value) {
      const lab = document.createElement('div');
      lab.style.cssText = 'margin-top:6px;font-size:11px;color:' + THEME.textSecondary;
      lab.textContent = labelText;
      form.appendChild(lab);
      const inp = document.createElement('input');
      inp.value = value;
      inp.style.cssText = inputCss;
      form.appendChild(inp);
      return inp;
    }
    // v9.21: тип документа — выпадающий список, чтобы PASSPORT был виден как
    // полноценный вариант, а не «знаешь — введёшь»
    function mkSelect(form, labelText, options, value) {
      const lab = document.createElement('div');
      lab.style.cssText = 'margin-top:6px;font-size:11px;color:' + THEME.textSecondary;
      lab.textContent = labelText;
      form.appendChild(lab);
      const sel = document.createElement('select');
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === value) o.selected = true;
        sel.appendChild(o);
      }
      sel.style.cssText = inputCss;
      form.appendChild(sel);
      return sel;
    }
    const fields = [
      ['docType', L('Документ', 'Document Type')],
      ['docNumber', L('Номер документа', 'Document Number')],
      ['fullName', L('Имя и фамилия как в документе', 'Full Name (as on document)')],
      ['birthYear', L('Год рождения', 'Year of Birth')],
      ['country', L('Страна (как в списке сайта)', 'Country (in Spanish as in site dropdown)')],
      ['phone', L('Телефон (без +34)', 'Phone (9 digits, without +34)')],
      ['email', 'Email'],
    ];
    const inputs = {};
    for (const [key, label] of fields) {
      inputs[key] = key === 'docType'
        ? mkSelect(settingsForm, label, ['NIE', 'PASSPORT'],
            (DATA.docType || 'NIE') === 'PASSPORT' ? 'PASSPORT' : 'NIE')
        : mkField(settingsForm, label, DATA[key] || ''); // v9.2: подпись над полем
    }
    const saveDataBtn = mkBtn(L('Сохранить данные', 'Save Personal Details'), 'success');
    // v9.3: активна, только когда хоть одно поле разошлось с сохранёнными
    // данными (docType сравниваем в той же нормализации, что и сохранение)
    const normDocType = (v) => ((v || 'NIE').toUpperCase() === 'PASSPORT' ? 'PASSPORT' : 'NIE');
    function dataDirty() {
      for (const [key] of fields) {
        let v = String(inputs[key].value).trim();
        if (key === 'docType') v = normDocType(v);
        if (v !== String(key === 'docType' ? normDocType(DATA[key]) : (DATA[key] || ''))) return true;
      }
      return false;
    }
    function updateSaveDataBtn() { setDim(saveDataBtn, !dataDirty()); }
    for (const [key] of fields) inputs[key].addEventListener('input', updateSaveDataBtn);
    updateSaveDataBtn(); // при создании: ничего не меняли — погашена
    saveDataBtn.onclick = () => {
      for (const [key] of fields) DATA[key] = inputs[key].value.trim();
      DATA.docType = (DATA.docType || 'NIE').toUpperCase() === 'PASSPORT' ? 'PASSPORT' : 'NIE';
      store.set('ck_data', JSON.stringify(DATA));
      updateSaveDataBtn(); // поля = данные → кнопка гаснет
      setFormOpen(settingsForm, false);
      status(dataReady() ? L('⚙️ Данные сохранены', '✅ Personal details saved').replace('⚙️', '✅') : L('⚙️ Не все поля заполнены', '⚙️ Not all required fields are filled'), dataReady() ? THEME.success : THEME.warning);
      renderStats();
    };
    settingsForm.appendChild(saveDataBtn);

    // какие услуги проверять (раздел «Настройки поиска»)
    const tramTitle = document.createElement('div');
    tramTitle.style.cssText = 'margin-top:4px;font-size:11px;font-weight:600;color:' + THEME.textSecondary;
    tramTitle.textContent = L('Какие услуги проверять:', 'Services to check:');
    searchForm.appendChild(tramTitle);
    const tramChecks = {};
    for (const t of TRAMITES) {
      const row = document.createElement('label');
      row.style.cssText = checkRowCss;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (DATA.tramites || []).includes(t.key);
      cb.style.cssText = 'margin:1px 0 0';
      tramChecks[t.key] = cb;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(L(t.label, t.labelEn || t.label)));
      searchForm.appendChild(row);
    }

    // офис проверять переехал на главную панель (v9.0) — тут только услуги и Cl@ve

    // Способ входа — взаимоисключающий выбор. Сертификат возможен только
    // внутри Cl@ve, поэтому отдельного состояния «сертификат без Cl@ve» нет.
    const sinClaveRow = document.createElement('label');
    sinClaveRow.style.cssText = checkRowCss + ';margin-top:8px;border-top:1px solid ' + THEME.border + ';padding-top:8px';
    const sinClaveRadio = document.createElement('input');
    sinClaveRadio.type = 'radio';
    sinClaveRadio.name = 'ck-clave-mode';
    sinClaveRadio.checked = !DATA.useClave;
    sinClaveRadio.style.cssText = 'margin:1px 0 0';
    sinClaveRow.appendChild(sinClaveRadio);
    sinClaveRow.appendChild(document.createTextNode(L('Без Cl@ve', 'Without Cl@ve (Sin Cl@ve)')));
    searchForm.appendChild(sinClaveRow);

    const claveRow = document.createElement('label');
    claveRow.style.cssText = checkRowCss + ';margin-top:5px';
    const claveRadio = document.createElement('input');
    claveRadio.type = 'radio';
    claveRadio.name = 'ck-clave-mode';
    claveRadio.checked = !!DATA.useClave;
    claveRadio.style.cssText = 'margin:1px 0 0';
    claveRow.appendChild(claveRadio);
    claveRow.appendChild(document.createTextNode(L('Через Cl@ve (сайт обещает лучший доступ)', 'Via Cl@ve (site offers better access)')));
    searchForm.appendChild(claveRow);

    const certRow = document.createElement('label');
    certRow.style.cssText = checkRowCss + ';margin-top:5px';
    const certCb = document.createElement('input');
    certCb.type = 'checkbox';
    certCb.checked = !!DATA.claveCert;
    certCb.style.cssText = 'margin:1px 0 0';
    certRow.appendChild(certCb);
    certRow.appendChild(document.createTextNode(L('Сертификатом в Chrome (eIdentifier)', 'With Digital Certificate in Chrome (eIdentifier)')));
    searchForm.appendChild(certRow);
    const certHint = document.createElement('div');
    certHint.style.cssText = 'margin:3px 0 0;font-size:10px;line-height:1.35;color:' + THEME.textSecondary;
    certHint.textContent = L('Сняли галочку — другой способ появится после завершения сессии Chrome.', 'If unchecked, another login method appears after the Chrome session ends.');
    searchForm.appendChild(certHint);
    // Кому записываемся (только при Cl@ve). Идея и первая реализация — PR #2
    // (Konstantin Chukreev); у нас выбор оформлен двумя пунктами вместо галочки.
    // «Себе» — на сайте жмём «Copiar a datos solicitante», сайт подставляет
    // владельца Cl@ve. «Другому» — «Copiar» не жмём (подставил бы владельца),
    // заявителя вписываем из «Моих данных».
    const applicantTitle = document.createElement('div');
    applicantTitle.style.cssText = 'margin-top:8px;font-size:11px;font-weight:600;color:' + THEME.textSecondary;
    applicantTitle.textContent = L('Кому записываемся:', 'Booking appointment for:');
    searchForm.appendChild(applicantTitle);
    const selfRow = document.createElement('label');
    selfRow.style.cssText = checkRowCss;
    const selfRadio = document.createElement('input');
    selfRadio.type = 'radio';
    selfRadio.name = 'ck-applicant';
    selfRadio.checked = DATA.copyFromClave !== false;
    selfRadio.style.cssText = 'margin:1px 0 0';
    selfRow.appendChild(selfRadio);
    selfRow.appendChild(document.createTextNode(L('Себе (владелец Cl@ve)', 'Myself (Cl@ve owner)')));
    searchForm.appendChild(selfRow);
    const otherRow = document.createElement('label');
    otherRow.style.cssText = checkRowCss;
    const otherRadio = document.createElement('input');
    otherRadio.type = 'radio';
    otherRadio.name = 'ck-applicant';
    otherRadio.checked = DATA.copyFromClave === false;
    otherRadio.style.cssText = 'margin:1px 0 0';
    otherRow.appendChild(otherRadio);
    otherRow.appendChild(document.createTextNode(L('Другому человеку (из «Мои данные»)', 'Another person (from "My Personal Details")')));
    searchForm.appendChild(otherRow);
    const applicantHint = document.createElement('div');
    applicantHint.style.cssText = 'margin:3px 0 0;font-size:10px;line-height:1.35;color:' + THEME.textSecondary;
    applicantHint.textContent = L('Данные заявителя скрипт возьмёт из «👤 Изменить мои данные».', 'Applicant details will be filled from "Edit My Personal Details".');
    searchForm.appendChild(applicantHint);
    function renderApplicantHint() {
      applicantHint.style.display = (claveRadio.checked && otherRadio.checked) ? 'block' : 'none';
    }
    function renderClaveControls() {
      const usingClave = claveRadio.checked;
      certRow.style.display = usingClave ? 'flex' : 'none';
      certHint.style.display = usingClave ? 'block' : 'none';
      applicantTitle.style.display = usingClave ? 'block' : 'none';
      selfRow.style.display = usingClave ? 'flex' : 'none';
      otherRow.style.display = usingClave ? 'flex' : 'none';
      renderApplicantHint();
      if (!usingClave) certCb.checked = false;
    }
    renderClaveControls();

    const saveSearchBtn = mkBtn(L('Сохранить настройки', 'Save Search Settings'), 'success');
    // v9.3: активна, только когда хоть одна галочка разошлась с сохранёнными
    function searchDirty() {
      for (const t of TRAMITES)
        if (tramChecks[t.key].checked !== (DATA.tramites || []).includes(t.key)) return true;
      if (claveRadio.checked !== !!DATA.useClave) return true;
      if (claveRadio.checked && certCb.checked !== !!DATA.claveCert) return true;
      if (claveRadio.checked && otherRadio.checked !== (DATA.copyFromClave === false)) return true;
      return false;
    }
    function updateSaveSearchBtn() { setDim(saveSearchBtn, !searchDirty()); }
    for (const t of TRAMITES) tramChecks[t.key].addEventListener('change', updateSaveSearchBtn);
    sinClaveRadio.addEventListener('change', () => { renderClaveControls(); updateSaveSearchBtn(); });
    claveRadio.addEventListener('change', () => { renderClaveControls(); updateSaveSearchBtn(); });
    certCb.addEventListener('change', updateSaveSearchBtn);
    function onApplicantChange() { renderApplicantHint(); updateSaveSearchBtn(); }
    selfRadio.addEventListener('change', onApplicantChange);
    otherRadio.addEventListener('change', onApplicantChange);
    updateSaveSearchBtn(); // при создании: ничего не меняли — погашена
    saveSearchBtn.onclick = () => {
      DATA.tramites = TRAMITES.filter((t) => tramChecks[t.key].checked).map((t) => t.key);
      DATA.useClave = claveRadio.checked;
      DATA.claveCert = DATA.useClave && certCb.checked;
      if (DATA.useClave) DATA.copyFromClave = selfRadio.checked;
      if (!DATA.tramites.length) { DATA.tramites = ['huellas']; tramChecks.huellas.checked = true; }
      store.set('ck_data', JSON.stringify(DATA));
      updateSaveSearchBtn(); // галочки = данные → кнопка гаснет
      SS.del('tramIdx'); // начать чередование с первой отмеченной
      setFormOpen(searchForm, false);
      status(L('✅ Настройки поиска сохранены', '✅ Search settings saved'), THEME.success);
      renderStats();
    };
    searchForm.appendChild(saveSearchBtn);

    // ---- «Настроить ритм проверки» (v8.0): то, что раньше было зашито в коде ----
    // Интервалы, горячие часы, ночная пауза и потолок окна редактируются
    // полями; готовые наборы — пресетами выбранного режима. Свои варианты
    // сохраняются кнопкой и живут в Tampermonkey рядом с данными. Форсаж
    // настраивается отдельно ниже.
    // v9.2: контейнер rhythmForm и inputCss объявлены выше (аккордеон).
    // Выбор пресета в списке применяется СРАЗУ (кнопки «Применить пресет»
    // больше нет); правка любого поля, расходящаяся с пресетом, переводит
    // список на «(свои значения)».

    const rhythmInputs = {};
    const modeTitle = document.createElement('div');
    modeTitle.style.cssText = 'margin-top:4px;font-size:11px;color:' + THEME.textSecondary;
    modeTitle.textContent = L('Способ планировать проверки:', 'Check scheduling mode:');
    rhythmForm.appendChild(modeTitle);
    const modeSel = document.createElement('select');
    modeSel.style.cssText = inputCss;
    for (const [value, text] of [['interval', L('Интервальный ритм', 'Interval rhythm')], ['hourly', L('Часовые окна', 'Hourly windows')]]) {
      const op = document.createElement('option'); op.value = value; op.textContent = text; modeSel.appendChild(op);
    }
    rhythmForm.appendChild(modeSel);

    const presetTitle = document.createElement('div');
    presetTitle.style.cssText = 'margin-top:6px;font-size:11px;color:' + THEME.textSecondary;
    presetTitle.textContent = L('Пресет ритма (выбор применяется сразу):', 'Rhythm preset (applies immediately):');
    rhythmForm.appendChild(presetTitle);
    const presetSel = document.createElement('select');
    presetSel.style.cssText = inputCss;
    rhythmForm.appendChild(presetSel);
    rhythmForm.appendChild(formDivider()); // граница «пресет | цифры»
    function renderPresetSel() {
      while (presetSel.firstChild) presetSel.removeChild(presetSel.firstChild);
      const allPresets = Object.assign({}, BUILTIN_PRESETS, readCustomPresets());
      for (const name of Object.keys(allPresets)) {
        const p = allPresets[name];
        if ((p.mode || 'interval') !== modeSel.value) continue;
        const op = document.createElement('option');
        op.value = name;
        op.textContent = (BUILTIN_PRESETS[name] ? '★ ' : '') + presetDisplay(name);
        presetSel.appendChild(op);
      }
      const own = document.createElement('option');
      own.value = '(свои)';
      own.textContent = L('✎ (свои значения)', '✎ (custom values)');
      presetSel.appendChild(own);
      presetSel.value = RUN.preset || '(свои)';
      if (presetSel.value !== (RUN.preset || '(свои)')) presetSel.value = '(свои)';
    }
    presetSel.onchange = () => {
      if (presetSel.value === '(свои)') {
        status(L('✎ Свои значения — правь поля ниже и нажми «Сохранить изменения»', '✎ Custom values — edit fields below and click "Save Changes"'), THEME.textSecondary);
        return;
      }
      if (applyPreset(presetSel.value)) {
        fillRhythmInputs(); // цифры полей = пресет
        status(L('✅ Пресет «' + RUN.preset + '» включён', '✅ Preset "' + presetDisplay(RUN.preset) + '" enabled'), THEME.success);
        renderStats();
      }
    };

    // Поля активной стратегии показываются, остальные скрываются.
    const RHYTHM_FIELDS = [
      ['hourlyWindowMin', L('Часовое окно, мин (1–55)', 'Hourly window, min (1–55)')],
      ['hourlyChecks', L('Проверок в окне (1–20; хаотично)', 'Checks in window (1–20; random)')],
      ['intervalRange', L('Интервал, мин (напр. 7 или 7–10)', 'Interval, min (e.g. 7 or 7–10)')],
      ['hotHours', L('Горячие часы (необязательно, напр. 6-13)', 'Peak hours (optional, e.g. 6-13)')],
      ['hotIntervalRange', L('Интервал горячих часов, сек (напр. 60 или 60–180)', 'Peak hours interval, sec (e.g. 60 or 60–180)')],
      ['activeHoursRange', L('Время работы проверки (0–24 = всё время)', 'Active hours (0–24 = 24/7)')],
      ['maxPerWindow', L('Макс. проверок за окно', 'Max checks per window')],
      ['windowMin', L('Длина окна, мин', 'Window length, min')],
      ['lostRetryRange', L('После срыва слотов — перепроверка, сек (напр. 5 или 5–12)', 'Retry after lost slots, sec (e.g. 5 or 5–12)')],
    ];
    function mkRhythmField(form, labelText, value) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px;width:100%;box-sizing:border-box';
      const inp = document.createElement('input');
      inp.value = value;
      inp.style.cssText = inputCss + ';width:92px;flex:none;margin-top:0'; // время — слева
      row.appendChild(inp);
      const lab = document.createElement('div');
      lab.style.cssText = 'flex:1;font-size:11px;line-height:1.35;color:' + THEME.textPrimary;
      lab.textContent = labelText;
      row.appendChild(lab);
      form.appendChild(row);
      inp._row = row;
      return inp;
    }
    for (const [key, label] of RHYTHM_FIELDS) {
      if (key === 'maxPerWindow') {
        const protectionTitle = document.createElement('div');
        protectionTitle.style.cssText = 'margin-top:10px;padding-top:7px;border-top:1px solid ' + THEME.border + ';font-size:11px;font-weight:600;color:' + THEME.textSecondary;
        protectionTitle.textContent = L('Темп и паузы', 'Pace & limits');
        rhythmForm.appendChild(protectionTitle);
      }
      rhythmInputs[key] = mkRhythmField(rhythmForm, label, String(RUN[key]));
    }
    const hourlyKeys = new Set(['hourlyWindowMin', 'hourlyChecks']);
    const intervalKeys = new Set(['intervalRange', 'hotHours', 'hotIntervalRange', 'activeHoursRange']);
    function renderRhythmMode() {
      const hourly = modeSel.value === 'hourly';
      for (const [key] of RHYTHM_FIELDS) {
        if (hourlyKeys.has(key)) rhythmInputs[key]._row.style.display = hourly ? 'flex' : 'none';
        if (intervalKeys.has(key)) rhythmInputs[key]._row.style.display = hourly ? 'none' : 'flex';
      }
    }
    modeSel.onchange = () => { renderPresetSel(); renderRhythmMode(); updateSaveRhythmBtn(); };

    // совпадают ли поля с выбранным пресетом? (v9.2: числа сравниваем как
    // числа — «0,4» и «0.4» одно и то же; горячие часы — как написаны)
    function matchesSelectedPreset() {
      const name = presetSel.value;
      if (name === '(свои)') return true;
      const p = Object.assign({}, BUILTIN_PRESETS, readCustomPresets())[name];
      if (!p) return true;
      if ((p.mode || 'interval') !== modeSel.value) return false;
      for (const [key] of RHYTHM_FIELDS) {
        if (hourlyKeys.has(key) && modeSel.value !== 'hourly') continue;
        if (intervalKeys.has(key) && modeSel.value !== 'interval') continue;
        if (key === 'hotIntervalRange' && !String(p.hotHours || '').trim()) continue;
        if (key === 'intervalRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(p.intervalMinMin, p.intervalMaxMin)) return false;
          continue;
        }
        if (key === 'hotIntervalRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(p.hotIntervalMinSec, p.hotIntervalMaxSec)) return false;
          continue;
        }
        if (key === 'activeHoursRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(p.activeFrom, p.activeTo)) return false;
          continue;
        }
        if (key === 'lostRetryRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(p.lostRetryMinSec, p.lostRetryMaxSec)) return false;
          continue;
        }
        if (key === 'hotHours') {
          if (String(rhythmInputs[key].value).trim() !== String(p[key])) return false;
        } else {
          const x = parseFloat(String(rhythmInputs[key].value).replace(',', '.'));
          const y = parseFloat(String(p[key]).replace(',', '.'));
          if (!(isFinite(x) && isFinite(y) && x === y)) return false;
        }
      }
      return true;
    }
    // правка поля, расходящаяся с пресетом, → список сам показывает «(свои)»
    for (const key of Object.keys(rhythmInputs)) {
      rhythmInputs[key].addEventListener('input', () => {
        if (!matchesSelectedPreset()) presetSel.value = '(свои)';
        updateSaveRhythmBtn(); // есть изменения — «Сохранить изменения» оживает
      });
    }

    // поля → объект с проверкой; null = что-то заполнено неверно
    function collectRhythm() {
      const v = {};
      const num = (key, lo, hi) => {
        const x = parseFloat(String(rhythmInputs[key].value).replace(',', '.'));
        if (!isFinite(x) || x < lo || x > hi) return false;
        v[key] = x;
        return true;
      };
      v.mode = modeSel.value;
      if (v.mode === 'hourly') {
        if (!num('hourlyWindowMin', 1, 55) || !num('hourlyChecks', 1, 20)) return null;
        v.hourlyWindowMin = Math.round(v.hourlyWindowMin); v.hourlyChecks = Math.round(v.hourlyChecks);
      } else {
        const range = parseIntervalRange(rhythmInputs.intervalRange.value, 0.1, 720);
        if (!range) return null;
        v.intervalMinMin = range[0]; v.intervalMaxMin = range[1];
        v.hotHours = rhythmInputs.hotHours.value.trim();
        if (v.hotHours) {
          const hotRange = parseIntervalRange(rhythmInputs.hotIntervalRange.value, 5, 3600);
          if (!hotRange || !parseHotHours(v.hotHours)) return null;
          v.hotIntervalMinSec = hotRange[0]; v.hotIntervalMaxSec = hotRange[1];
        }
        const activeRange = parseIntervalRange(rhythmInputs.activeHoursRange.value, 0, 24);
        if (!activeRange) return null;
        v.activeFrom = Math.round(activeRange[0]); v.activeTo = Math.round(activeRange[1]);
      }
      if (!num('maxPerWindow', 1, 60) || !num('windowMin', 1, 240)) return null;
      v.maxPerWindow = Math.round(v.maxPerWindow);
      const retryRange = parseIntervalRange(rhythmInputs.lostRetryRange.value, 2, 600);
      if (!retryRange) return null;
      v.lostRetryMinSec = retryRange[0]; v.lostRetryMaxSec = retryRange[1];
      return v;
    }
    function fillRhythmInputs() {
      for (const [key] of RHYTHM_FIELDS) {
        rhythmInputs[key].value = key === 'intervalRange'
          ? formatIntervalRange(RUN.intervalMinMin, RUN.intervalMaxMin)
          : key === 'hotIntervalRange'
            ? !String(RUN.hotHours || '').trim()
              ? '' : formatIntervalRange(RUN.hotIntervalMinSec, RUN.hotIntervalMaxSec)
            : key === 'activeHoursRange'
              ? formatIntervalRange(RUN.activeFrom, RUN.activeTo)
              : key === 'lostRetryRange'
                ? formatIntervalRange(RUN.lostRetryMinSec, RUN.lostRetryMaxSec) : String(RUN[key]);
      }
      modeSel.value = RUN.mode || 'interval';
      renderRhythmMode();
      renderPresetSel();
      renderState(); // в подписи галочки форсажа — интервал из RUN.boostSec
      updateSaveRhythmBtn(); // поля = текущий ритм → «Сохранить изменения» гаснет
    }

    // v9.2: «Сохранить изменения» (бывш. «Сохранить ритм»): активна только
    // когда хоть одно поле разошлось с текущим ритмом (RUN) — жать нечего,
    // пока ничего не менялось. Погашена — полупрозрачная и не кликается.
    const saveRhythmBtn = mkBtn(L('Сохранить изменения', 'Save Changes'), '#27ae60');
    function rhythmDirty() {
      if (modeSel.value !== RUN.mode) return true;
      for (const [key] of RHYTHM_FIELDS) {
        if (key === 'intervalRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(RUN.intervalMinMin, RUN.intervalMaxMin)) return true;
          continue;
        }
        if (key === 'hotIntervalRange') {
          if (!String(RUN.hotHours || '').trim()) {
            if (String(rhythmInputs[key].value).trim()) return true;
            continue;
          }
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(RUN.hotIntervalMinSec, RUN.hotIntervalMaxSec)) return true;
          continue;
        }
        if (key === 'activeHoursRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(RUN.activeFrom, RUN.activeTo)) return true;
          continue;
        }
        if (key === 'lostRetryRange') {
          if (String(rhythmInputs[key].value).trim() !== formatIntervalRange(RUN.lostRetryMinSec, RUN.lostRetryMaxSec)) return true;
          continue;
        }
        if (key === 'hotHours') {
          if (String(rhythmInputs[key].value).trim() !== String(RUN[key])) return true;
        } else {
          const x = parseFloat(String(rhythmInputs[key].value).replace(',', '.'));
          if (!(isFinite(x) && x === RUN[key])) return true;
        }
      }
      return false;
    }
    function updateSaveRhythmBtn() {
      setDim(saveRhythmBtn, !rhythmDirty());
    }
    updateSaveRhythmBtn(); // при создании: поля ещё не меняли — погашены
    // общая команда для верхней (под форсажем) и нижней кнопки сохранения
    function saveRhythmChanges() {
      const v = collectRhythm();
      if (!v) { status(L('⚠️ Проверь поля ритма (часы пишут как «6-13, 19-23»)', '⚠️ Check rhythm fields (write hours like "6-13, 19-23")'), '#ff8888'); return; }
      // v9.2: пресет в списке ещё выбран и цифры ему соответствуют — сохраняем
      // с его именем; любая правка отвалилась на «(свои)» — так и пишем
      const keep = (presetSel.value !== '(свои)' && matchesSelectedPreset()) ? presetSel.value : '(свои)';
      RUN = Object.assign({}, RUN, v, { preset: keep });
      SS.del('boostUntil'); // v9.0: ключ авто-форсажа протух — подчистить
      store.set('ck_run', JSON.stringify(RUN));
      fillRhythmInputs();
      status(keep !== '(свои)'
        ? L('✅ Изменения сохранены — пресет «' + keep + '»', '✅ Changes saved — preset "' + presetDisplay(keep) + '"')
        : L('✅ Изменения сохранены (свои значения)', '✅ Changes saved (custom values)'), '#7CFC00');
      renderStats();
    }
    saveRhythmBtn.onclick = saveRhythmChanges;
    rhythmForm.appendChild(saveRhythmBtn);
    rhythmForm.appendChild(formDivider()); // делит «Сохранить изменения» и блок своего пресета

    const presetNameInp = mkField(rhythmForm, L('Имя для своего пресета', 'Custom preset name'), ''); // v9.2: подпись над полем
    const savePresetBtn = mkBtn(L('Сохранить как пресет', 'Save as Preset'), '#27ae60');
    // v9.3: активна, только когда введено имя (цифры могут и совпадать — новое
    // имя и есть то, что сохраняем)
    function updateSavePresetBtn() { setDim(savePresetBtn, !presetNameInp.value.trim()); }
    presetNameInp.addEventListener('input', updateSavePresetBtn);
    updateSavePresetBtn(); // при создании: имя пустое — погашена
    savePresetBtn.onclick = () => {
      const v = collectRhythm();
      if (!v) { status(L('⚠️ Проверь поля ритма (часы пишут как «6-13, 19-23»)', '⚠️ Check rhythm fields (write hours like "6-13, 19-23")'), '#ff8888'); return; }
      const name = presetNameInp.value.trim();
      if (!name) { status(L('⚠️ Введи имя пресета', '⚠️ Enter a preset name'), '#ff8888'); return; }
      if (BUILTIN_PRESETS[name]) { status(L('⚠️ Имя занято встроенным пресетом', '⚠️ Name is reserved by a built-in preset'), '#ff8888'); return; }
      const customs = readCustomPresets();
      // v9.3: интервал форсажа — не часть пресета; в RUN он из v попадает
      // (остаётся настройкой), а в сам пресет не записывается
      const presetVals = { ...v };
      customs[name] = presetVals;
      writeCustomPresets(customs);
      RUN = Object.assign({}, RUN, v, { preset: name });
      SS.del('boostUntil');
      store.set('ck_run', JSON.stringify(RUN));
      presetNameInp.value = '';
      updateSavePresetBtn(); // имя очищено → кнопка гаснет
      fillRhythmInputs();
      status(L('✅ Пресет «' + name + '» сохранён и включён', '✅ Preset "' + name + '" saved and enabled'), '#7CFC00');
      renderStats();
    };
    rhythmForm.appendChild(savePresetBtn);
    const delPresetBtn = mkBtn(L('Удалить свой пресет', 'Delete Custom Preset'), '#c0392b');
    delPresetBtn.onclick = () => {
      const name = presetSel.value;
      if (BUILTIN_PRESETS[name] || name === '(свои)') { status(L('⚠️ Встроенные пресеты не удаляются', '⚠️ Built-in presets cannot be deleted'), '#ff8888'); return; }
      const customs = readCustomPresets();
      if (!customs[name]) return;
      delete customs[name];
      writeCustomPresets(customs);
      if (RUN.preset === name) {
        RUN.preset = '(свои)';
        store.set('ck_run', JSON.stringify(RUN));
      }
      fillRhythmInputs();
      status(L('🗑 Пресет «' + name + '» удалён', '🗑 Preset "' + name + '" deleted'), '#bbb');
    };
    rhythmForm.appendChild(delPresetBtn);

    // (пошаговый режим, «Следующий шаг» и проверка голоса переехали на главную
    // панель в «Общие настройки» — v9.0; отдельного раздела отладки больше нет)

    // v9.2: в DOM формы уже вставлены под своими кнопками (аккордеон);
    // здесь только регистрируем их в списке «открыт один — прочие закрыты»
    const boostInput = mkRhythmField(boostForm, L('Форсаж: интервал, сек (10–3600)', 'Boost: interval, sec (10–3600)'), String(RUN.boostSec));
    const saveBoostBtn = mkBtn(L('Сохранить интервал форсажа', 'Save Boost Interval'), '#27ae60');
    function boostDirty() {
      const sec = parseFloat(String(boostInput.value).replace(',', '.'));
      return !(isFinite(sec) && sec === RUN.boostSec);
    }
    function updateSaveBoostBtn() { setDim(saveBoostBtn, !boostDirty()); }
    boostInput.addEventListener('input', updateSaveBoostBtn);
    updateSaveBoostBtn();
    saveBoostBtn.onclick = () => {
      const sec = parseFloat(String(boostInput.value).replace(',', '.'));
      if (!isFinite(sec) || sec < 10 || sec > 3600) { status(L('⚠️ Интервал форсажа: 10–3600 сек', '⚠️ Boost interval: 10–3600 sec'), '#ff8888'); return; }
      RUN.boostSec = sec;
      store.set('ck_run', JSON.stringify(RUN));
      updateSaveBoostBtn();
      renderState();
      status(L('✅ Интервал форсажа сохранён', '✅ Boost interval saved'), '#7CFC00');
    };
    boostForm.appendChild(saveBoostBtn);

    collapsibles.push(settingsForm, searchForm, rhythmForm, boostForm);

    // журнал последних проверок и ошибок
    const logBox = document.createElement('pre');
    logBox.style.cssText =
      'display:none;margin:6px 0 0;padding:8px 10px;max-height:190px;overflow:auto;' +
      'background:' + THEME.bgMain + ';border:1px solid ' + THEME.border + ';border-radius:6px;' +
      'font:10.5px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;color:' + THEME.textSecondary;
    const logBtn = mkBtn(L('Показать журнал', 'Show Log'), 'secondary');
    logBtn.onclick = () => {
      if (logBox.style.display === 'none') {
        // формат «ДД.ММ ЧЧ:ММ значок подпись: доп», напр.
        // «29.07 09:07 · сит нет: huellas, сразу, BCN-RAMBLA». Держим ≤~40 символов
        // плашки (см. правило в CLAUDE.md); не режем — длиннее перенесётся (сигнал
        // сократить). Полная история — в journal.log.
        const fmt = (t) => {
          const d = new Date(t);
          return String(d.getDate()).padStart(2, '0') + '.' +
            String(d.getMonth() + 1).padStart(2, '0') + ' ' + d.toTimeString().slice(0, 5);
        };
        const rows = readLog().slice(-25).reverse().map((e) => {
          const mark = (LOG_LABELS[e.s] && LOG_LABELS[e.s][0]) || '·';
          const label = logLabelText(e.s);
          const extra = (e.x && e.s !== 'UNKNOWN') ? ': ' + e.x : '';
          return fmt(e.t) + ' ' + mark + ' ' + label + extra;
        });
        logBox.textContent = rows.join('\n') || L('Журнал пуст', 'Log is empty');
        logBox.style.display = 'block';
        logBtn.textContent = L('Скрыть журнал', 'Hide Log');
      } else {
        logBox.style.display = 'none';
        logBtn.textContent = L('Показать журнал', 'Show Log');
      }
    };
    utilBody.appendChild(logBtn);
    utilBody.appendChild(logBox);

    // Небольшая постоянная ссылка: не собирает логи, не отправляет данные и
    // не влияет на проверку. В Telegram пользователь приходит только по клику.
    const supportLink = document.createElement('a');
    supportLink.href = 'https://t.me/edlevina';
    supportLink.target = '_blank';
    supportLink.rel = 'noopener noreferrer';
    supportLink.textContent = L('Написать автору оригинала (Telegram)', 'Contact Original Author (Telegram)');
    supportLink.className = 'ck-btn ck-btn-secondary';
    supportLink.style.cssText = 'display:block;text-decoration:none;font-size:11px;margin-top:6px;padding:6px 8px';
    utilBody.appendChild(supportLink);

    utilDetails.appendChild(utilBody);
    box.appendChild(utilDetails);

    imHereBtn = mkBtn(L('Я тут — хватит звать', "I'm Here — Stop Calling"), 'success');
    imHereBtn.style.display = 'none';
    imHereBtn.onclick = () => stopAlertLoop();
    box.appendChild(imHereBtn);

    // приписка «кто что делает» + версия (v9.2: версия переехала сюда из
    // строки «Общих настроек» — как в старых версиях, в самом низу; текст
    // служебный — серый, как до 9.2)
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid ' + THEME.border + ';font-size:10.5px;color:' + THEME.textSecondary;
    hint.textContent = L(
      'Слоты/телефон заполнит само. SMS-код и Confirmar — за тобой. v' + SCRIPT_VER,
      'Autofills slots & contact info. SMS code & Confirmar are up to you. v' + SCRIPT_VER
    );
    box.appendChild(hint);
    document.body.appendChild(box);
    renderStats();
  }

  // ---------- утилиты формы (как в v3) ----------
  function tooManyP1Submits() {
    const now = Date.now();
    let arr = [];
    try { arr = JSON.parse(sessionStorage.getItem('p1submits') || '[]'); } catch (e) {}
    arr = arr.filter((t) => now - t < 25000);
    sessionStorage.setItem('p1submits', JSON.stringify(arr));
    return arr.length >= 3;
  }
  function noteP1Submit() {
    let arr = [];
    try { arr = JSON.parse(sessionStorage.getItem('p1submits') || '[]'); } catch (e) {}
    arr.push(Date.now());
    sessionStorage.setItem('p1submits', JSON.stringify(arr));
  }
  const lastAction = {};
  function recently(name, ms) {
    const t = lastAction[name] || 0;
    if (Date.now() - t < ms) return true;
    lastAction[name] = Date.now();
    return false;
  }
  // нормализация для сопоставления офисов: сайт пишет имена с испанскими
  // диакритиками (Rubí, Mataró), ключи OFFICES — без них (RUBI, MATARO);
  // сравниваем без надстрочных знаков — «RUBÍ» совпадает с «RUBI»
  const deaccent = (s) => (s || '').toUpperCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  function findOption(sel, keywords) {
    if (!sel) return null;
    for (const o of sel.options) {
      const up = deaccent(o.text);
      for (const kw of keywords) if (up.includes(deaccent(kw))) return o;
    }
    return null;
  }
  function selectOption(sel, opt) {
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // ШАГ 3.5: какой из предложенных сайтом офисов брать. Чистая функция —
  // проверяется подстановкой списков без реальных сит. Правила:
  // 1) первый предложенный из выбранных (панель «Офисы, которые проверяем»);
  // 2) выбранных нет, но ничего не выбрано (провинция) или разрешён «любой» —
  //    берём второй офис (за первый конкурируют все), иначе первый;
  // 3) выбранных нет, «любой» не разрешён — null: чужие офисы = «сит нет».
  function pickOffice(offered, selKeys, allowAny) {
    for (const o of offered) {
      const up = deaccent(o.text);
      for (const k of selKeys) if (up.includes(deaccent(k))) {
        return { opt: o, kind: L('выбранный', 'selected'), mine: true };
      }
    }
    if (selKeys.length && !allowAny) return null;
    const any = offered[1] || offered[0] || null;
    return any ? { opt: any, kind: offered[1] ? L('второй', 'second') : L('первый', 'first'), mine: false } : null;
  }
  function findTramite(keyword) {
    // v9.23: без диакритиков — как у офисов (findOption): услуга tarjetas
    // не должна зависеть от того, написало ли сайт «GESTIÓN» с ударением
    for (const s of document.querySelectorAll('select[id^="tramiteGrupo"]')) {
      for (const o of s.options) {
        if (deaccent(o.text).includes(deaccent(keyword))) return { sel: s, opt: o };
      }
    }
    return null;
  }
  function setSelectByText(sel, text) {
    if (!sel) return false;
    const t = text.trim().toUpperCase();
    for (const o of sel.options)
      if (o.text.trim().toUpperCase() === t) { sel.value = o.value; sel.dispatchEvent(new Event('change',{bubbles:true})); return true; }
    for (const o of sel.options)
      if (o.text.trim().toUpperCase().startsWith(t)) { sel.value = o.value; sel.dispatchEvent(new Event('change',{bubbles:true})); return true; }
    return false;
  }
  function fill(el, val) {
    if (!el) return false;
    el.focus(); el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // HTML-снимок найденной страницы: доказательство, что это ситы, а не ошибка.
  // <base> добавляем, чтобы стили/картинки подтянулись при открытии онлайн.
  // v7.30: сначала отправляем страницу хелперу — он кладёт файл в snaps/
  // в папке проекта (ИИ-сессия видит находку целиком, не только журнал).
  // Хелпер молчит — по-старому скачиваем в Downloads.
  function buildFoundSnapshot() {
    try {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      const name = 'cita-found_' + stamp + '.html';
      const head = '<!-- cita-catcher: находка ' + d.toLocaleString('ru') +
        ' — ' + location.href + ' -->\n<base href="' + location.origin + '/">\n';
      return { name: name, html: head + document.documentElement.outerHTML };
    } catch (e) { return null; }
  }
  function downloadSnapshot(s) {
    const blob = new Blob([s.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = s.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  function sendFoundSnapshot() {
    const s = buildFoundSnapshot();
    if (!s) return null;
    if (!isMac) { downloadSnapshot(s); return s.name; }
    gmPost(CONFIG.alertServer + '/htmlsnap?name=' + encodeURIComponent(s.name), s.html, 8000)
      .then(() => { helperOk = true; })
      .catch(() => { helperOk = false; downloadSnapshot(s); }); // хелпер молчит — в Downloads
    return s.name;
  }
  // Человеческое заполнение формы: поля по очереди с паузами, потом действие
  // (обычно отправка). Сайт меряет скорость ввода и при мгновенном заполнении даёт
  // коды «слишком быстрый ввод»: 0017 на форме заявителя, 0018 на телефоне/почте —
  // и ситу мы теряем. Возвращает, сколько миллисекунд займёт весь ввод.
  // v9.25.1: в пошаговом режиме шаги складываются в очередь, и каждый клик
  // «Следующий шаг» исполняет один (заявитель: Copiar → поля/страна → Enviar).
  // До v9.25.1 таймеры заполнения гасились guard'ом !stepMode — вместе с ними
  // молча умерло заполнение по кнопке: экраны заявителя/телефона в пошаговом
  // не заполнялись вообще (жалоба 13.10). Очередь живёт в пределах страницы:
  // новый экран = новая загрузка = пустая очередь.
  let fillStepQueue = null;
  function fillHumanly(steps, done, minSec, maxSec) {
    if (stepMode()) {
      if (fillStepQueue && fillStepQueue.length) return 0; // уже идёт — дальше по кнопке
      fillStepQueue = steps.slice();
      fillStepQueue.push(done);
      status(L('👣 Пошаговое заполнение: ' + fillStepQueue.length + ' шагов — жми «Следующий шаг»', '👣 Step-by-step filling: ' + fillStepQueue.length + ' steps — click "Next Step"'), '#ffd27f');
      fillStepQueue.shift()();
      return 0;
    }
    // minSec/maxSec — свои паузы для конкретного экрана (телефон быстрее, v7.30);
    // без них — обычный человеческий темп humanFill*
    const lo = (minSec != null) ? minSec : CONFIG.humanFillMinSec;
    const hi = (maxSec != null) ? maxSec : CONFIG.humanFillMaxSec;
    const gap = () => (lo + Math.random() * (hi - lo)) * 1000;
    let t = gap();
    for (const step of steps) {
      const at = t;
      setTimeout(() => { if (!stepMode()) step(); }, at);
      t += gap();
    }
    setTimeout(() => { if (!stepMode()) done(); }, t + gap());
    return t;
  }
  function clickBtn(...candidates) {
    for (const c of candidates) {
      let el = null;
      if (c.startsWith('#')) el = document.querySelector(c);
      else el = [...document.querySelectorAll('input[type=submit],input[type=button],button,a')]
        .find((b) => ((b.value || b.textContent || '').trim().toLowerCase()).includes(c.toLowerCase()));
      if (el) { el.click(); return true; }
    }
    return false;
  }
  function isBlocked() {
    const t = document.body ? document.body.innerText.toLowerCase() : '';
    return t.includes('requested url was rejected') || t.includes('support id') ||
           t.includes('too many request');
  }
  // какой именно блок — короткая метка для журнала (полностью — в README):
  // F5 = «requested URL was rejected», 429 = «too many requests»
  function blockKind() {
    const t = document.body ? document.body.innerText.toLowerCase() : '';
    if (t.includes('too many request')) return '429';
    if (t.includes('requested url was rejected') || t.includes('support id')) return 'F5';
    return '';
  }
  // ближайший кликабельный предок (ссылка/кнопка/onclick), иначе сам элемент
  function clickableAncestor(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const tag = n.tagName;
      if (tag === 'A' || tag === 'BUTTON') return n;
      if (n.getAttribute && (n.getAttribute('onclick') || n.getAttribute('role') === 'button')) return n;
    }
    return el;
  }
  // кликнуть по САМОМУ КОМПАКТНОМУ элементу с текстом reInclude (и без reExclude) —
  // блоки «Presentación con/sin Cl@ve» это не <button>, а кликабельные div/ссылки
  function clickByText(reInclude, reExclude) {
    let best = null, bestLen = 1e9;
    for (const el of document.querySelectorAll('a,button,input[type=submit],input[type=button],div,td,li,span,p')) {
      const t = (el.innerText || el.value || '').trim();
      if (!t || t.length > 200) continue;
      if (!reInclude.test(t)) continue;
      if (reExclude && reExclude.test(t)) continue;
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    if (!best) return false;
    clickableAncestor(best).click();
    return true;
  }
  const hasClaveChoice = () => /presentaci[oó]n\s+sin\s+cl@ve/i.test(
    document.body ? document.body.innerText : '');

  // ---------- возврат через Volver (гипотеза 02.09) ----------
  // Ручной замер Екатерины 01.09: 20 проверок подряд через кнопку Volver
  // (разные офисы, ~10 минут) — ни одного блока, тогда как чекер на перезаходах
  // страницей ловит F5 даже на скромном темпе. Похоже, блоки считает вход в
  // НОВУЮ сессию (полная загрузка стартовой страницы), а не сами проверки:
  // Volver возвращает в поиск сит в той же сессии. Поэтому следующая проверка
  // начинается кликом Volver с экрана-вердикта «нет сит», а перезаход —
  // только если Volver нет (не тот экран / сессия протухла / вёрстка сменилась).
  // Кнопку ищем по надписи, НАЧИНАЮЩЕЙСЯ с «volver» (не подстрокой — «Devolver»
  // и прочее не трогаем). v7.29: сайт рисует кнопки не только input[submit/button]
  // и button/a — бывает input[type=image] (надпись в alt/value) и div-кнопки
  // ([role=button]); раньше такие не находились, и при ВИДИМОЙ кнопке чекер
  // делал полный перезаход (журнал 02.09 16:08: три «сит нет» подряд без ↩).
  // Невидимые элементы пропускаем, настоящие кнопки предпочитаем ссылкам.
  function findVolverBtn() {
    const isVolver = (b) =>
      /^volver\b/i.test((b.value || b.alt || b.title || b.textContent || '').trim());
    const cands = [...document.querySelectorAll(
      'input[type=submit],input[type=button],input[type=image],button,a,[role=button]'
    )].filter(isVolver);
    const visible = cands.filter((b) => b.getClientRects().length);
    const pool = visible.length ? visible : cands;
    return pool.find((b) => b.tagName === 'INPUT' || b.tagName === 'BUTTON') || pool[0];
  }
  function onNoCitasVerdict() {
    const t = document.body ? document.body.innerText.toLowerCase() : '';
    return t.includes('no hay citas disponibles') || t.includes('no hay suficientes citas');
  }

  // ---------- watchdog'и: незнакомая страница и застрявшая доводка ----------
  const pageLoadedAt = Date.now();
  let recognizedOnce = false;   // хоть один известный шаг узнан на этой странице
  let lastKnownStep = '';
  let lastProgressAt = Date.now();
  function noteStep(name) {
    recognizedOnce = true;
    if (name !== lastKnownStep) { lastKnownStep = name; lastProgressAt = Date.now(); }
  }
  function watchdog() {
    if (!driving() || waiting || stopped || alertTimer) return;
    const age = (Date.now() - pageLoadedAt) / 1000;
    if (!recognizedOnce && age > CONFIG.unknownAfterSec) {
      // незнакомая страница (недогрузилась? капча? новая вёрстка?) — fail-safe
      snapOnce('unknown'); // страница целиком в снимки, не 500 символов
      recordResult('UNKNOWN', (document.body ? document.body.innerText : '').slice(0, 500));
      if (foundMode()) {
        status(L('⚠️ ЦИТЫ ЕСТЬ, но страница незнакомая — доделай вручную!', '⚠️ SLOTS AVAILABLE, but unknown page — please finish manually!'), '#ffcc66');
        stopped = true;
        startAlertLoop('help');
        return;
      }
      if (onceOnly()) { // разовая проверка не просила ретраев незнакомых страниц
        SS.del('once');
        checkerStop(L('⚠️ Незнакомая страница — разовая проверка остановлена', '⚠️ Unknown page — single check stopped'));
        return;
      }
      // сайт бывает флейковым: одиночный сбой — не повод бросать вахту
      const unknowns = getUnknowns() + 1;
      setUnknowns(unknowns);
      if (unknowns >= CONFIG.maxConsecutiveUnknown) {
        checkerStop(L('⚠️ ' + unknowns + ' незнакомые страницы подряд — проверка остановлена', '⚠️ ' + unknowns + ' unknown pages in a row — checking stopped'), 'unknown');
      } else {
        stopped = true; // не трогать эту страницу, ждать перезагрузки по таймеру
        scheduleNext(CONFIG.unknownRetryMin * 60000,
          L('Незнакомая страница №' + unknowns + ', попробую снова', 'Unknown page #' + unknowns + ', will retry'));
        fireAlert('error', L('Незнакомая страница №' + unknowns + ', повтор через ' + CONFIG.unknownRetryMin + ' мин', 'Unknown page #' + unknowns + ', retry in ' + CONFIG.unknownRetryMin + ' min'));
      }
      return;
    }
    if (foundMode() && recognizedOnce &&
        (Date.now() - lastProgressAt) / 1000 > CONFIG.stallAfterSec &&
        lastKnownStep !== 'final') {
      status(L('⚠️ ЦИТЫ ЕСТЬ, но автозаполнение застряло — доделай вручную!', '⚠️ SLOTS AVAILABLE, but autofill stalled — please finish manually!'), '#ffcc66');
      stopped = true;
      startAlertLoop('help');
    }
  }

  // -------- главный пошаговый автомат: один шаг за тик --------
  let tramMissingSince = 0; // ждём перестройку списка услуг после выбора офиса
  let claveWaitSince = 0;   // с какого момента висим на экране авторизации Cl@ve
  function tick() {
    if (!document.body) return;
    // v9.4: страница переведена — испанские маркеры переписаны, любой клик
    // будет наугад. Автомат молчит, пока перевод не выключат (жёлтая строка
    // в heartbeat). См. pageTranslated.
    if (pageTranslated()) return;
    // v9.4: schedulePending — пауза из самого расписания (см. комментарий
    // там): «назад» из кэша больше не обходит отсчёт после блока/вердикта.
    if (!forcingStep && (stopped || waiting || schedulePending())) return;

    if (isBlocked()) {
      noteStep('blocked');
      if (onceOnly()) { // разовая проверка упёрлась в блок — останавливаемся честно
        SS.del('once');
        checkerStop(L('⛔️ Блокировка сайта — разовая проверка остановлена', '⛔️ Site blocked (WAF) — single check stopped'));
        return;
      }
      if (driving()) {
        // близко к прошлому блоку (< blockDecayMin) — эскалируем; иначе свежий счёт
        const now = Date.now();
        const chained = getLastBlockAt() && (now - getLastBlockAt() < CONFIG.blockDecayMin * 60000);
        const blocks = chained ? getBlocks() + 1 : 1;
        setBlocks(blocks);
        setLastBlockAt(now);
        recordResult('WAF_BLOCKED', blockKind()); // помечаем тип: F5 WAF или 429 «too many requests»
        bumpTodayBlocks(); // статистика «блоков за сегодня» (v9.1)
        recordHit(); // блокированная попытка тоже обращение к сайту — учитываем в окне
        if (blocks >= CONFIG.maxConsecutiveBlocks) {
          checkerStop(L('⛔️ ' + blocks + ' блокировок подряд — проверка остановлена', '⛔️ ' + blocks + ' blocks in a row — checking stopped'), 'stopped');
        } else {
          const idx = Math.min(blocks - 1, CONFIG.backoffMin.length - 1);
          scheduleNext(CONFIG.backoffMin[idx] * 60000,
            L('WAF-блок №' + blocks + ', пауза ' + CONFIG.backoffMin[idx] + ' мин', 'WAF block #' + blocks + ', pause ' + CONFIG.backoffMin[idx] + ' min'));
          fireAlert('error', L('WAF-блок №' + blocks + ', пауза ' + CONFIG.backoffMin[idx] + ' мин', 'WAF block #' + blocks + ', pause ' + CONFIG.backoffMin[idx] + ' min'));
        }
      } else {
        status(L('⛔️ Блокировка сайта (WAF). Жми «назад» и пробуй снова.', '⛔️ Site blocked (WAF). Go back and try again later.'), '#ff8888');
        stopped = true;
      }
      return;
    }

    // Сессия сайта протухла между проверками («Su sesión ha caducado») —
    // это не поломка: просто начинаем проверку с первой страницы
    const earlyText = document.body.innerText.toLowerCase();
    if (earlyText.includes('sesión ha caducado') || earlyText.includes('sesion ha caducado')) {
      noteStep('caducada');
      if (!driving()) {
        // v8.1: проверка не идёт — не кликаем сами; раньше молча жал Aceptar
        if (!recently('caducada', 5000)) status(L('Сессия протухла — нажми Aceptar сама (проверка выключена)', 'Session expired — click Aceptar manually (checker is off)'), '#ffcc66');
        return;
      }
      const n = parseInt(SS.get('caducada') || '0', 10) + 1;
      SS.set('caducada', String(n));
      if (n > 3) {
        // рестарт не помогает — не зацикливаемся, пробуем позже
        if (onceOnly()) { SS.del('once'); checkerStop(L('⚠️ Сессия не восстанавливается — разовая проверка остановлена', '⚠️ Session recovery failed — single check stopped')); return; }
        recordResult('SESSION_LOOP');
        scheduleNext(CONFIG.unknownRetryMin * 60000, L('Сессия не восстанавливается', 'Session recovery failed'));
        fireAlert('error', L('Сессия сайта не восстанавливается, повтор через ' + CONFIG.unknownRetryMin + ' мин', 'Site session not recovering, retry in ' + CONFIG.unknownRetryMin + ' min'));
        return;
      }
      if (!recently('caducadaReload', 15000)) {
        status(L('Сессия сайта протухла — начинаю проверку заново…', 'Site session expired — restarting check…'));
        location.replace(SS.get('startUrl') || DEFAULT_START);
      }
      return;
    }

    // Плановое обслуживание сайта («servicio de cita previa interrumpido /
    // tareas de mantenimiento / no estará disponible unos minutos»). Это НЕ блок,
    // НЕ экран входа Cl@ve и НЕ поломка вёрстки — сайт временно недоступен. Раньше
    // чекер в режиме Cl@ve принимал этот незнакомый экран за экран авторизации и
    // звал зря. Теперь: ждём и пробуем позже, человека не зовём.
    if (driving() && (earlyText.includes('tareas de mantenimiento') ||
        earlyText.includes('cita previa interrumpido') ||
        earlyText.includes('no estará disponible') ||
        earlyText.includes('no estara disponible'))) {
      noteStep('mantenimiento');
      if (onceOnly()) { SS.del('once'); checkerStop(L('🛠️ Обслуживание сайта — разовая проверка остановлена, повторишь позже', '🛠️ Site maintenance — single check stopped, try later')); return; }
      resetTransient();
      claveWaitSince = 0; SS.del('clavePending'); // сбрасываем ложное «жду Cl@ve»
      recordResult('SITE_MAINTENANCE');
      recordHit();
      scheduleNext(CONFIG.unknownRetryMin * 60000,
        L('Обслуживание сайта, повтор через ' + CONFIG.unknownRetryMin + ' мин', 'Site maintenance, retry in ' + CONFIG.unknownRetryMin + ' min'));
      return;
    }

    // Внутренняя ошибка сайта («Se ha producido un error inesperado… inicia
    // de nuevo el proceso», а с сентября — «error en el sistema… inténtelo
    // de nuevo») — сайт сам просит начать заново.
    // Лесенка: мгновенный рестарт ×3 → повторы раз в 7 мин ×3 → стоп с голосом.
    if (earlyText.includes('error inesperado') ||
        earlyText.includes('error en el sistema') ||
        earlyText.includes('inténtelo de nuevo') ||
        earlyText.includes('intentelo de nuevo')) {
      noteStep('siteerror');
      if (!driving()) {
        if (!recently('siteerr', 5000)) status(L('⚠️ Сайт: внутренняя ошибка — нажми Aceptar', '⚠️ Site internal error — click Aceptar'), '#ffcc66');
        return;
      }
      const n = parseInt(SS.get('siteerr') || '0', 10) + 1;
      SS.set('siteerr', String(n));
      if (n > 3) {
        softFail('SITE_ERROR', L('Сайт: внутренняя ошибка не уходит', 'Site internal error persists'));
        return;
      }
      recordResult('SITE_ERROR', L('мгновенный рестарт №' + n, 'instant restart #' + n));
      if (n === 1) fireAlert('error', L('Сайт: внутренняя ошибка, перезапускаюсь', 'Site internal error, restarting'));
      if (!recently('siteerrReload', 15000)) {
        status(L('Сайт: внутренняя ошибка — начинаю заново (№' + n + ')…', 'Site internal error — restarting (#' + n + ')…'));
        location.replace(SS.get('startUrl') || DEFAULT_START);
      }
      return;
    }

    // ЭКРАН ПОСЛЕ ФИНАЛА — «CITA CONFIRMADA»: сита подтверждена, бронь
    // завершена (впервые дошли до него 29.09 на бете recogida — раньше
    // watchdog считал его «незнакомой страницей» и зовал голосом на помощь).
    // Ничего не кликаем: justificante с номером записи остаётся человеку.
    if (earlyText.includes('cita confirmada')) {
      noteStep('confirmada');
      if (foundMode() || driving()) {
        if (!recently('confirmada', 30000)) {
          stopAlertLoop();
          recordResult('SLOTS_CONFIRMED', currentTramite().key); // строка 41 симв. — в бюджете ~40
          SS.del('found'); SS.del('on'); SS.del('once'); SS.del('boostRun');
          SS.del('clavePending');
          waiting = false; stopped = true;
          sendBeat(); // сторожу: выключились осознанно, не зови
          status(L('✅ СИТА ПОДТВЕРЖДЕНА — всё готово! Номер записи (justificante) на странице', '✅ APPOINTMENT CONFIRMED — all done! Your confirmation (justificante) is on the page'), '#7CFC00');
          renderState();
        }
      }
      return; // проверка не идёт — страницу старого подтверждения не трогаем
    }

    // Страница выбора провинции («PROVINCIAS DISPONIBLES», index.html). Сюда
    // можно вывалиться кнопкой Volver с экрана-вердикта или возвратом из Cl@ve:
    // на ней нет ни #sede, ни вердикта — раньше она считалась «незнакомой» и в
    // режиме Cl@ve вешала чекер на «жду авторизацию». Теперь сами выбираем
    // BARCELONA и жмём Acepto — сессия сохраняется, перезаход страницей не нужен.
    if (driving() && /provincias disponibles/i.test(earlyText)) {
      noteStep('province');
      claveWaitSince = 0; SS.del('clavePending'); // это не экран авторизации
      const pb = parseInt(SS.get('provBounce') || '0', 10);
      if (pb > 4) { softFail('UNKNOWN', L('зациклился выбор провинции', 'province selection loop')); return; }
      const sel = document.querySelector('select');
      if (sel && setSelectByText(sel, 'BARCELONA')) {
        if (recently('provinceSel', 60000)) {
          // выбор сделан прошлым тиком — теперь жмём Acepto (отдельный тик,
          // чтобы сайт успел переварить выбор); счётчик отскоков +1 за попытку
          if (!recently('provinceGo', 8000)) {
            SS.set('provBounce', String(pb + 1));
            status(L('Выбор провинции — жму Acepto и продолжаю…', 'Province selection — clicking Acepto…'));
            clickBtn('aceptar', 'acepto');
          }
        } else status(L('Экран выбора провинции — выбираю BARCELONA…', 'Province selection screen — selecting BARCELONA…'));
        return;
      }
      // селекта нет или BARCELONA в нём нет — перезаход страницей (тоже отскок)
      if (!recently('provinceReload', 60000)) {
        SS.set('provBounce', String(pb + 1));
        location.replace(SS.get('startUrl') || DEFAULT_START);
      }
      return;
    }

    // ШАГ 1 — выбор офиса и услуги
    const sede = document.querySelector('#sede');
    if (sede) {
      // v8.1/v9.0: проверка НЕ идёт — первую страницу не ведём. Раньше скрипт
      // сам начинал проверку (офис → услуга → Aceptar → …до вердикта) при любом
      // открытии стартовой страницы — выглядело как «проверка сама включилась».
      // Автозаполнение глубоких экранов (NIE/телефон, если дошла сама) остаётся.
      // «Следующий шаг» (пошаговая отладка) по-прежнему работает по кнопке.
      if (!driving() && !foundMode() && !forcingStep) {
        status(L('📡 Проверка выключена — страницу не трогаю', '📡 Checker is OFF — leaving page untouched'), '#bbb');
        return;
      }
      noteStep('step1');
      SS.del('caducada'); // форма открылась — рестарты после протухшей сессии обнуляем
      SS.del('provBounce'); // прошли выбор провинции — счётчик отскоков чист
      if (tooManyP1Submits()) {
        // v9.25.1: в режиме сертификата цикл первого экрана сразу после захода
        // в Cl@ve — почти всегда незакрытое нативное окно Chrome с выбором
        // сертификата: платформа по таймауту возвращает на сайт без авторизации,
        // и форма уходит по кругу (жалоба 13.10 — «первый экран зациклился»).
        // Не бросаем вахту сразу: зовём голосом, форму не трогаем, повторяем
        // позже; после 3 таких кругов подряд — прежний жёсткий стоп.
        // certLoops чистится на глубоких экранах (заявитель/меню/вердикт) —
        // значит, авторизация прошла и цикл закончился.
        const flowAt = parseInt(store.get('ck_claveFlow', '0'), 10);
        const certLoops = parseInt(SS.get('certLoops') || '0', 10);
        if (DATA.useClave && DATA.claveCert && flowAt &&
            Date.now() - flowAt < 5 * 60000 && certLoops < 3) {
          SS.set('certLoops', String(certLoops + 1));
          if (!recently('certWait', 90000)) {
            recordResult('CLAVE_AUTH_WAIT');
            fireAlert('cert');
          }
          stopped = true; // форму не трогаем — ждём человека, повтор по расписанию
          scheduleNext(CONFIG.unknownRetryMin * 60000, L('Сертификат не подтверждён — повторю', 'Certificate not confirmed — will retry'));
          return;
        }
        status(L('⚠️ Первый экран не пропускает. Проверь данные/выбери вручную, я на паузе.', '⚠️ First screen is not advancing. Check details/select manually, paused.'), '#ffcc66');
        stopped = true;
        if (driving()) checkerStop(L('⚠️ Первый экран зациклился — проверка остановлена', '⚠️ First screen looped — checking stopped'), 'unknown');
        return;
      }
      // v9.22: ровно один выбранный офис — ищем точечно (вердикт «нет сит»
      // сайт отдаёт сразу после формы); пусто (провинция) или 2+ — ищем
      // CUALQUIER: один заход покрывает все выбранные офисы
      const selOffices = selectedOffices();
      const wantKey = selOffices.length === 1 ? selOffices[0].key : 'CUALQUIER';
      const wantOffice = findOption(sede, [wantKey]);
      if (!wantOffice) {
        softFail('OFFICE_MISSING', selOffices.length === 1 ? selOffices[0].short : 'CUALQUIER');
        return;
      }
      if (sede.value !== wantOffice.value) {
        status(L('Выбираю офис: ', 'Selecting office: ') + (selOffices.length === 1 ? selOffices[0].label : 'Cualquier oficina'));
        selectOption(sede, wantOffice);
        return; // следующий тик проверит список услуг
      }
      const tram = findTramite(currentTramite().keyword);
      if (!tram) {
        // список услуг перестраивается после выбора офиса — даём ему до 8 секунд
        if (!tramMissingSince) { tramMissingSince = Date.now(); return; }
        if (Date.now() - tramMissingSince < 8000) return;
        // услуги нет и после ожидания — это ошибка, о которой надо знать
        softFail('TRAMITE_MISSING', L('Услуга «' + currentTramite().key + '» не найдена в списке', 'Service "' + currentTramite().key + '" not found in dropdown'));
        return;
      }
      tramMissingSince = 0;
      if (tram.sel.value !== tram.opt.value) {
        status(L('Выбираю услугу (', 'Selecting service (') + currentTramite().key + ')…');
        selectOption(tram.sel, tram.opt);
        return; // дать сайту «устаканиться» перед сабмитом
      }
      if (tram && tram.sel.value === tram.opt.value) {
        if (!recently('aceptar', 5000)) {
          status(L('Жму «Aceptar»…', 'Clicking "Aceptar"…'));
          noteP1Submit();
          clickBtn('#btnAceptar', 'aceptar');
        }
      }
      return;
    }

    // Слотов нет. «no hay citas disponibles» — это ВЕРДИКТ сайта, слотов нет,
    // независимо от того, есть на странице форма или нет. На авторизованной
    // Cl@ve-странице сайт пишет «no hay citas» И показывает форму, НО подпись у неё
    // «Si desea consultar o anular una cita, rellene…» — это форма посмотреть/
    // отменить СУЩЕСТВУЮЩУЮ запись, а не получить новую. Раньше тут стояло
    // `&& !#txtIdCitado`, из-за чего на этом экране чекер зря лез заполнять форму
    // и получал 0017. Теперь: увидели «no hay citas» → «сит нет», форму не трогаем.
    const bodyText = document.body.innerText.toLowerCase();
    if (bodyText.includes('no hay citas disponibles') ||
        bodyText.includes('no hay suficientes citas')) {
      noteStep('nocitas');
      SS.del('certLoops'); // вердикт получен — cert-цикл закончен (v9.25.1)
      if (foundMode() && driving()) {
        // слоты были и испарились на полпути: окно часто возвращается
        // (сорванные брони отпадают) — продолжаем охоту на той же услуге,
        // а человека зовём один раз, чтобы был рядом к капче
        snapOnce('lost', currentTramite().key); // на каком экране сгорели ситы
        recordResult('SLOTS_LOST', currentTramite().key);
        recordHit();
        SS.del('found');
        SS.del('clavePending'); // проверка завершена — флаг Cl@ve не переживает её (v7.27)
        fireAlert('help');
        // мгновенная перепроверка: сорванный слот часто тут же возвращается,
        // ждать обычный ритм — упустить окно возврата (интервал — в настройках ритма)
        const lostRetry = (RUN.lostRetryMinSec +
          Math.random() * (RUN.lostRetryMaxSec - RUN.lostRetryMinSec)) * 1000;
        scheduleNext(lostRetry, L('Слоты сорвались (' + currentTramite().key + ') · 🔁 сразу перепроверяю', 'Slots lost (' + currentTramite().key + ') · 🔁 retrying immediately'));
        return;
      }
      if (driving()) {
        // Клик Volver не перезагрузил страницу? (volverAt жив ТОЛЬКО если boot()
        // не выполнялся — при реальной навигации boot() его сносит.) Даём странице
        // 2.5 с на выгрузку, потом перепробуем кнопку (до 3 раз) и уходим в
        // обычный перезаход. Без этого зависший Volver молча сжигал бы проверки.
        const vAt = parseInt(SS.get('volverAt') || '0', 10);
        if (vAt) {
          if (Date.now() - vAt < 2500) return; // страница ещё может выгружаться
          const n = parseInt(SS.get('volverTries') || '0', 10) + 1;
          const btn = findVolverBtn();
          if (n <= 3 && btn) {
            status(L('↩️ Volver не сработал, пробую снова (№' + n + ')…', '↩️ Volver did not navigate, retrying (#' + n + ')…'), '#ffd27f');
            SS.set('volverTries', String(n));
            SS.set('volverAt', String(Date.now()));
            btn.click();
          } else { // кнопки нет или 3 попытки впустую — полный перезаход
            SS.del('volverAt'); SS.del('volverTries'); SS.del('viaVolver');
            SS.set('volverMiss', '1'); // в журнале следующего вердикта будет ↪
            location.replace(SS.get('startUrl') || DEFAULT_START);
          }
          return;
        }
        resetTransient(); // гасим сиюминутные ошибки; счётчик WAF-блоков — по времени
        SS.del('clavePending'); // проверка завершена — флаг Cl@ve не переживает её (v7.27)
        const numM = document.body.innerText.match(/(\d{4})\s+Cod\.?\s*Oper/i);
        const scr = document.querySelector('#txtIdCitado') ? L('форма', 'form') : 'Salir';
        const depth = SS.get('deepFill') ? L('после данных', 'after details') : L('сразу', 'immediate'); // v9.5
        const where = officesShort(); // v9.5→9.22: офис/офисы этой проверки
        const via = SS.get('viaVolver') ? '↩' : (SS.get('volverMiss') ? '↪' : '');
        SS.del('viaVolver'); SS.del('volverMiss');
        recordHit(); // учли обращение к сайту в скользящем окне лимита
        if (numM) { // 4-значный код = бот-блок, «нет сит» тут ложное
          snapOnce('codeblock', numM[1] + ' ' + scr); // экран с кодом — в снимки
          recordResult('CODE_BLOCK', numM[1] + ', ' + scr);
        } else { // чистый «нет сит»
          recordResult('NO_SLOTS', via + currentTramite().key + ', ' + depth + ', ' + where);
        }
        SS.del('deepFill'); // v9.5: вердикт записан — глубина израсходована
        nextTramite(); // следующий цикл — следующая отмеченная услуга
        if (rhythmOn() || boostRun()) {
          const delay = jitteredDelayMs(); // выставляет SS.lastGap, если это шаг серии
          const why = L('Сит нет (', 'No slots (') + currentTramite().key + ')' +
            (boostRun() ? L(' · 🔥 форсаж', ' · 🔥 boost') : SS.get('lastGap') ? ' · ' + SS.get('lastGap') : '');
          scheduleNext(delay, why);
        } else {
          // v9.0: «Проверить сейчас» обещал ОДИН цикл — вердикт получен, машина молчит
          SS.del('once');
          waiting = false; stopped = true;
          status(L('✅ Разовая проверка завершена: ', '✅ Single check finished: ') + (numM ? L('бот-блок ', 'bot-block ') + numM[1] : L('сит нет', 'no slots')), '#7CFC00');
          renderState();
        }
      } else {
        status(L('🔁 Сейчас сит нет — жми «Проверить сейчас» или запусти ритм', '🔁 No slots right now — click "Check Now" or "Start Checking"'), '#ffd27f');
        stopped = true;
      }
      return;
    }

    // ШАГ 2 — развилка «Presentación con/sin Cl@ve» (сайт сам пишет, что через
    // Cl@ve/сертификат доступ к записи лучше). Выбор пути — по галочке useClave.
    if (hasClaveChoice()) {
      // проверка не идёт — путь выбираешь сама (кроме явного «Следующий шаг»)
      if (!driving() && !foundMode() && !forcingStep) return;
      if (DATA.useClave) {
        noteStep('claveChoice');
        if (!recently('conClave', 5000)) {
          status(L('🔐 Иду путём Cl@ve (лучший доступ)…', '🔐 Proceeding via Cl@ve…'), '#7CFC00');
          SS.set('clavePending', String(Date.now()));
          // Cl@ve уводит на clave.gob.es — sessionStorage там теряется.
          // Дублируем состояние в localStorage, чтобы возобновиться по возврату.
          const resumePayload = JSON.stringify({
            startUrl: SS.get('startUrl') || DEFAULT_START,
            tramIdx: SS.get('tramIdx') || '0', ts: Date.now(),
            driver: onceOnly() ? 'once' : 'rhythm', // v9.0: чем вернуться — разовой или ритмом
          });
          localStorage.setItem('ck_claveResume', resumePayload);
          store.set('ck_claveResumeGM', resumePayload);
          // флаг для скрипта на pasarela.clave.gob.es (GM-хранилище — общее для доменов)
          store.set('ck_claveFlow', String(Date.now()));
          // «con Cl@ve», но не «sin Cl@ve»
          clickByText(/con\s+cl@ve/i, /sin\s+cl@ve/i);
        }
      } else {
        noteStep('sinClave');
        if (!recently('sinClave', 5000)) {
          status(L('Иду без Cl@ve (быстрое заполнение)…', 'Proceeding without Cl@ve (fast fill)…'));
          clickByText(/sin\s+cl@ve/i, null);
        }
      }
      return;
    }

    if (DATA.useClave && SS.get('clavePending')) {
      const cpAt = parseInt(SS.get('clavePending') || '0', 10);
      const known = document.querySelector('#sede, #txtIdCitado, #txtTelefonoCitado, select#idSede') ||
        /no hay citas|no hay suficientes|libre|ocupado/i.test(document.body.innerText) ||
        [...document.querySelectorAll('input[type=submit],input[type=button],button,a')]
          .some((b) => /solicitar\s+cita|anular\s+cita/i.test(b.value || b.textContent || ''));
      if (!known && cpAt && Date.now() - cpAt > 4 * 60000) {
        claveWaitSince = 0;
        SS.del('clavePending');
        localStorage.removeItem('ck_claveResume');
        status(L('🔐 Cl@ve-ожидание снято по таймауту — продолжаю обычные шаги…', '🔐 Cl@ve wait timed out — continuing normal steps…'), '#ffd27f');
      } else if (!known) {
        noteStep('claveAuth'); // считаем известным шагом — не UNKNOWN
        if (!claveWaitSince) claveWaitSince = Date.now();
        if (Date.now() - claveWaitSince < 25000) {
          status(L('🔐 Прохожу авторизацию Cl@ve…', '🔐 Authenticating via Cl@ve…'));
        } else if (!recently('claveAuthCall', 90000)) {
          status(L('🔐 Авторизуйся через Cl@ve (приложение/сертификат) — я жду и продолжу', '🔐 Please authenticate via Cl@ve (app/certificate) — waiting to continue'), '#ffcc66');
          recordResult('CLAVE_AUTH_WAIT');
          fireAlert('clave'); // отдельное сообщение, НЕ «ситы есть»
        }
        return;
      } else {
        claveWaitSince = 0;
        SS.del('clavePending'); // авторизация прошла, дальше обычные шаги
        localStorage.removeItem('ck_claveResume');
      }
    }

    // ШАГ 2b — старый вариант: простая инфо-страница → Entrar
    if (document.querySelector('#btnEntrar') ||
        [...document.querySelectorAll('input,button,a')].some((b) => /entrar/i.test(b.value || b.textContent || ''))) {
      noteStep('step2');
      if (!recently('entrar', 5000)) {
        status(L('Перехожу дальше (Entrar)…', 'Proceeding (Entrar)…'));
        clickBtn('#btnEntrar', 'entrar');
      }
      return;
    }

    // ШАГ 3 — личные данные
    const idField = document.querySelector('#txtIdCitado');
    if (idField) {
      noteStep('step3');
      SS.del('certLoops'); // дошли до заявителя — авторизация прошла, cert-цикл закончен (v9.25.1)
      SS.set('deepFill', '1'); // v9.5: дошли до экрана заявителя
      if (!dataReady()) {
        status(L('⚙️ Заполни данные (кнопка «👤 Изменить мои данные») — без них дальше нельзя', '⚙️ Fill in your details ("Edit My Personal Details") — required to proceed'), '#ffcc66');
        stopped = true;
        if (driving()) checkerStop(L('⚙️ Нет личных данных — проверка остановлена', '⚙️ Missing personal details — checking stopped'));
        return;
      }
      if (stepMode() || !recently('fillpersonal', 20000)) {
        const otherApplicant = DATA.useClave && DATA.copyFromClave === false;
        const copyBtn = otherApplicant ? null
          : [...document.querySelectorAll('input[type=button],input[type=submit],button,a')]
            .find((b) => /copiar\s+a\s+datos|copiar.*solicitante/i.test(b.value || b.textContent || ''));
        status(otherApplicant ? L('Вписываю заявителя из моих данных…', 'Filling applicant details from My Personal Details…')
          : copyBtn ? L('Копирую данные из Cl@ve (как человек)…', 'Copying details from Cl@ve…')
          : L('Вписываю данные заявителя…', 'Filling applicant details…'));
        const radio = DATA.docType === 'PASSPORT'
          ? document.querySelector('#rdbTipoDocPas, input[name="rdbTipoDoc"][value*="PAS"]')
          : document.querySelector('#rdbTipoDocNie, input[name="rdbTipoDoc"][value*="N.I.E"]');
        const yr = document.querySelector('#txtAnnoCitado');
        const pais = document.querySelector('#txtPaisNac');
        const fillRemainder = () => {
          if (radio && !radio.checked) radio.click();
          if (otherApplicant || !idField.value) fill(idField, DATA.docNumber);
          const nm = document.querySelector('#txtDesCitado');
          if (nm && (otherApplicant || !nm.value)) fill(nm, DATA.fullName);
          if (yr && (otherApplicant || !yr.value) && DATA.birthYear) fill(yr, DATA.birthYear);
        };
        const steps = [];
        if (copyBtn) {
          steps.push(() => copyBtn.click());
          steps.push(() => { fillRemainder(); if (pais) setSelectByText(pais, DATA.country); });
        } else {
          steps.push(fillRemainder);
          if (pais) steps.push(() => setSelectByText(pais, DATA.country));
        }
        fillHumanly(steps, () => {
          status(L('Отправляю данные…', 'Submitting applicant details…'));
          clickBtn('#btnEnviar', 'aceptar', 'solicitar');
        }, CONFIG.personalFillMinSec, CONFIG.personalFillMaxSec);
      }
      return;
    }

    // ШАГ 3.4 — меню действий после личных данных → «Solicitar Cita»
    const solicitarBtn = [...document.querySelectorAll('input[type=submit],input[type=button],button,a')]
      .find((b) => /solicitar\s+cita/i.test(b.value || b.textContent || ''));
    if (solicitarBtn) {
      noteStep('actions');
      SS.del('certLoops'); // меню после авторизации — cert-цикл закончен (v9.25.1)
      if (!recently('solicitar', 5000)) {
        status(L('Запрашиваю ситы (Solicitar Cita)…', 'Requesting appointment (Solicitar Cita)…'));
        solicitarBtn.click();
      }
      return;
    }

    // ШАГ 3.5 — сайт предлагает офисы со свободными слотами (позитивный признак сит!)
    const idSede = document.querySelector('select#idSede');
    if (idSede) {
      noteStep('office2');
      if (!recently('office2', 5000)) {
        const opts = [...idSede.options].filter((o) => o.value);
        if (opts.length) {
          const selKeys = selectedOffices().map((o) => o.key);
          const pick = pickOffice(opts, selKeys, officeAnyEffective());
          if (!pick) {
            if (stepMode()) {
              status(L('⏸️ Ситы есть, но не в моих офисах — шаг не продолжаю', '⏸️ Slots exist, but not in your selected offices — pausing step'), '#ffd27f');
              return;
            }
            status(L('⏸️ Ситы есть, но не в моих офисах (предложено ' + opts.length + ') — продолжаю проверку', '⏸️ Slots exist, but not in your selected offices (' + opts.length + ' offered) — continuing search'), '#ffd27f');
            recordResult('OFFICE_NOTOURS', opts.length + L(' чужих', ' other'));
            recordHit();
            SS.del('deepFill'); // вердикт записан — глубина израсходована
            SS.del('clavePending'); // проверка завершена — флаг Cl@ve не переживает её
            SS.del('viaVolver'); SS.del('volverMiss');
            nextTramite(); // следующий цикл — следующая отмеченная услуга
            if (rhythmOn() || boostRun()) {
              scheduleNext(jitteredDelayMs(),
                L('Не в моих офисах (', 'Not in selected offices (') + currentTramite().key + ')');
            } else {
              // разовая проверка дошла до вердикта — машина замолкает
              SS.del('once');
              waiting = false; stopped = true;
              status(L('✅ Разовая проверка завершена: ситы есть, но не в моих офисах', '✅ Single check finished: slots exist, but not in your selected offices'), '#7CFC00');
              renderState();
            }
            return;
          }
          markFound();
          status(L('🎉 Ситы есть! Беру ', '🎉 Slots found! Picking ') + (pick.mine ? L('выбранный', 'selected') :
            pick.kind + (selKeys.length ? L(' (не из выбранных)', ' (any-office fallback)') : '')) +
            L(' офис из ', ' office out of ') + opts.length + '…', '#7CFC00');
          selectOption(idSede, pick.opt);
          const officeWaitMs = Math.round(1400 + Math.random() * 800); // 1.4–2.2s human pace so F5 WAF doesn't block acVerFormulario
          setTimeout(() => { if (!stepMode()) clickBtn('#btnSiguiente', 'siguiente'); }, officeWaitMs);
        }
      }
      return;
    }

    // ШАГ 3.8 — новый экран слотов: календарь LIBRE/OCUPADO + КАПЧА
    const bodyLow = document.body.innerText.toLowerCase();
    if (bodyLow.includes('captcha') &&
        (bodyLow.includes('citas disponibles') || /\blibre\b/i.test(document.body.innerText))) {
      noteStep('slotsCaptcha');
      markFound();
      if (!recently('slotsCaptcha', 600000)) {
        try {
          let first = null;
          const dates = [];
          for (const el of document.querySelectorAll('td, a, input[type=button], button, div, span')) {
            if (((el.textContent || el.value || '').trim().toUpperCase()) !== 'LIBRE') continue;
            el.style.outline = '2px solid #7CFC00';
            if (!first) first = el;
            const cell = el.closest('td, li, div');
            const t = ((cell ? cell.innerText : el.textContent) || '').trim()
              .replace(/\s+/g, ' ').slice(0, 40);
            if (t && !dates.includes(t)) dates.push(t);
          }
          if (first) first.click();
          snapOnce('captcha', 'LIBRE: ' + (dates.join(' | ') || '—'));
        } catch (e) {}
        const cap = [...document.querySelectorAll('input[type=text]')]
          .find((i) => /texto|captcha|codigo/i.test(
            (i.placeholder || '') + ' ' + (i.id || '') + ' ' + (i.name || '')));
        if (cap) { cap.focus(); cap.style.outline = '3px solid #e74c3c'; }
        status(L('🎉 СИТЫ НА ЭКРАНЕ! Введи капчу и жми дальше!', '🎉 SLOTS ON SCREEN! Enter the captcha and click continue!'), '#7CFC00');
        recordResult('SLOTS_CAPTCHA', currentTramite().key);
        startAlertLoop('help');
      }
      return;
    }

    // ШАГ 4 — выбор слота (главный позитивный признак: слоты реально предложены)
    const slot = document.querySelector('input[type=radio][id^="rdbCita"]');
    if (slot) {
      noteStep('step4');
      markFound();
      if (!recently('slot', 5000)) {
        const lbl = slot.closest('label, tr, td');
        const st = ((lbl ? lbl.innerText : '') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
        status(L('🎉 Есть слот! Выбираю первый…', '🎉 Slot available! Selecting the first one…'), '#7CFC00');
        snapOnce('slot', st); // выбранный слот — в снимки (что именно взяли)
        slot.checked = true;
        slot.dispatchEvent(new Event('change', { bubbles: true }));
        const slotWaitMs = Math.round(1400 + Math.random() * 800); // 1.4–2.2s human pace so F5 WAF doesn't block slot submit
        setTimeout(() => { if (!stepMode()) clickBtn('#btnSiguiente', 'siguiente'); }, slotWaitMs);
      }
      return;
    }

    // ШАГ 5 — телефон + email
    const tel = document.querySelector('#txtTelefonoCitado');
    if (tel) {
      noteStep('step5');
      if (stepMode() || !recently('contact', 20000)) {
        snapOnce('telefono');
        status(L('Вписываю телефон и email по-человечески…', 'Filling phone and email at human pace…'));
        fillHumanly([
          () => fill(tel, DATA.phone),
          () => fill(document.querySelector('#emailUNO'), DATA.email),
          () => fill(document.querySelector('#emailDOS'), DATA.email),
        ], () => {
          status(L('Отправляю контакты…', 'Submitting contact info…'));
          clickBtn('#btnSiguiente', 'siguiente');
        }, CONFIG.contactFillMinSec, CONFIG.contactFillMaxSec);
      }
      return;
    }

    // ФИНАЛ — отметить согласие, но НЕ подтверждать. Дальше только человек.
    const smsField = document.querySelector('input[id*="sms" i], input[name*="sms" i], input[id*="codigo" i]');
    const confirmBtn = [...document.querySelectorAll('input[type=submit],input[type=button],button')]
      .find((b) => /confirmar/i.test(b.value || b.textContent || ''));
    if (smsField || confirmBtn) {
      noteStep('final');
      snapOnce('final'); // экран финала — в снимки: видно, что именно осталось человеку
      const chk = document.querySelector('#chkTotal, input[type=checkbox]');
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (smsField) status(L('✅ ВВЕДИ SMS-КОД И НАЖМИ CONFIRMAR', '✅ ENTER SMS CODE AND CLICK CONFIRMAR'), '#7CFC00');
      else status(L('✅ Всё заполнено — проверь экран и нажми Confirmar', '✅ All filled — review the page and click Confirmar'), '#7CFC00');
      if (foundMode() && !alertTimer && !recently('finalalert', 60000)) {
        recordResult('SLOTS_FOUND_FINAL');
        startAlertLoop('found'); // голос зовёт, пока не нажато «Я тут»
      }
      return;
    }
    // ничего не узнали — молчим, watchdog разберётся (UNKNOWN)
  }

  function markFound() {
    if (SS.get('found') !== '1') {
      SS.set('found', '1');
      SS.del('viaVolver'); SS.del('volverMiss'); // метки ↩/↪ нужны только «сит нет»
      resetErrors();
      snapOnce('found', currentTramite().key); // первый экран находки — в снимки
      // снимок страницы с ситами (раз на находку) — доказательство, что это ситы
      const snap = CONFIG.saveFoundHtml ? sendFoundSnapshot() : null;
      recordResult('SLOTS_FOUND', currentTramite().key + (snap ? L(' · снимок: ', ' · snap: ') + snap : ''));
    }
  }

  // Возврат с авторизации Cl@ve (clave.gob.es теряет sessionStorage) —
  // восстанавливаем состояние проверки из localStorage, если оно свежее.
  function restoreClaveSession() {
    if (!DATA.useClave) return;
    // Also check GM store in case we bounced back from a Cl@ve SAML error page
    let r = null;
    let gmR = null;
    try { gmR = JSON.parse(store.get('ck_claveResumeGM', 'null') || 'null'); } catch (e) {}
    try { r = JSON.parse(localStorage.getItem('ck_claveResume') || 'null') || gmR; } catch (e) { r = gmR; }
    store.set('ck_claveResumeGM', '');
    const samlErrCount = (gmR && gmR.samlErr) ? gmR.samlErr : 0;
    if (samlErrCount) {
      recordResult('SITE_ERROR', L('ошибка SAML Cl@ve №' + samlErrCount + '/3 — перезапуск', 'Cl@ve SAML error #' + samlErrCount + '/3 — restarted'));
    }
    if (driving()) return;
    if (r && Date.now() - r.ts < 15 * 60000) {
      // v9.0: возобновляем тем же водителем, с которым ушли на Cl@ve
      if (r.driver === 'once') SS.set('once', '1'); else SS.set('on', '1');
      if (r.startUrl) SS.set('startUrl', r.startUrl);
      SS.set('tramIdx', r.tramIdx || '0');
      if (samlErrCount) {
        SS.del('clavePending'); // SAML failed: start cleanly from Step 1
      } else {
        SS.set('clavePending', String(Date.now()));
      }
    } else if (r) {
      localStorage.removeItem('ck_claveResume'); // протухло
    }
  }

  // ---- платформа Cl@ve (pasarela.clave.gob.es): авто-клик «Access eIdentifier» ----
  const onClavePlatform = /(^|\.)clave\.gob\.es$/i.test(location.hostname);
  function clickClaveTile(reInclude) {
    // сперва среди кликабельных (кнопка/ссылка) с нужным текстом
    const clk = [...document.querySelectorAll('a,button,input[type=submit],input[type=button]')]
      .find((b) => reInclude.test((b.value || b.textContent || '').trim()));
    if (clk) { clk.click(); return true; }
    return clickByText(reInclude, null); // иначе — по тексту с подъёмом к предку
  }
  // маленькая плашка на платформе Cl@ve — видно, что скрипт тут работает
  function claveBadge(msg, color) {
    let b = document.getElementById('ck-clave-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'ck-clave-badge';
      b.style.cssText =
        'position:fixed;top:8px;right:8px;z-index:2147483647;background:#111;color:#fff;' +
        'font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:8px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:240px';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = '🔐 cita: ' + msg;
    b.style.color = color || '#fff';
  }
  function isClaveErrorPage() {
    const txt = (document.body ? document.body.innerText : '');
    return /invalid session for the saml request|se ha producido un error|reint[eé]ntelo de nuevo m[aá]s tarde/i.test(txt);
  }
  function recoverFromClaveError() {
    const flowAt = parseInt(store.get('ck_claveFlow', '0'), 10);
    // Only auto-redirect if the checker actively initiated this Cl@ve flow within the last 10 min
    if (!flowAt || Date.now() - flowAt > 10 * 60000) {
      claveBadge(L('ошибка SAML Cl@ve (проверка не активна)', 'Cl@ve SAML error (checker not active)'), '#ff8888');
      return true;
    }
    let errs = parseInt(store.get('ck_claveSamlErrs', '0'), 10);
    const lastErrAt = parseInt(store.get('ck_claveSamlErrAt', '0'), 10);
    if (Date.now() - lastErrAt > 15 * 60000) errs = 0; // reset counter after 15 min without SAML errors
    errs++;
    store.set('ck_claveSamlErrs', String(errs));
    store.set('ck_claveSamlErrAt', String(Date.now()));
    if (errs > 3) {
      claveBadge(L('⛔ ошибка SAML Cl@ve 3 раза подряд — стоп, проверь вручную', '⛔ Cl@ve SAML error 3x in a row — stopped, check manually'), '#ff8888');
      fireAlert('stopped');
      return true;
    }
    let targetUrl = DEFAULT_START;
    try {
      const r = JSON.parse(store.get('ck_claveResumeGM', 'null') || 'null') || {};
      if (r.startUrl) targetUrl = r.startUrl;
      r.samlErr = errs;
      r.ts = Date.now();
      store.set('ck_claveResumeGM', JSON.stringify(r));
    } catch (e) {}
    claveBadge(L('⚠️ ошибка SAML Cl@ve (№' + errs + '/3) — возвращаюсь на старт через 6 с…', '⚠️ Cl@ve SAML error (#' + errs + '/3) — returning to start in 6s…'), '#ffcc66');
    setTimeout(() => { location.replace(targetUrl); }, 6000);
    return true;
  }
  function clavePlatformFlow() {
    if (!DATA.useClave) return; // не наш случай — молчим
    if (isClaveErrorPage() && recoverFromClaveError()) return;
    if (!DATA.claveCert) { claveBadge(L('выбери способ входа вручную', 'select login method manually'), '#ffd27f'); return; }
    const flowAt = parseInt(store.get('ck_claveFlow', '0'), 10);
    const last = parseInt(store.get('ck_claveClicked', '0'), 10);
    if (last > flowAt && Date.now() - last < 15000) {
      claveBadge(L('только что нажала eIdentifier, жду…', 'just clicked eIdentifier, waiting…'), '#7CFC00');
      return;
    }
    claveBadge(L('ищу кнопку eIdentifier…', 'looking for eIdentifier button…'), '#ffd27f');
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (isClaveErrorPage()) {
        clearInterval(timer);
        recoverFromClaveError();
        return;
      }
      // «Access eIdentifier» / «Acceder eIdentificador» — сертификатный путь
      if (clickClaveTile(/eidentifier|eidentificador|certificad/i)) {
        store.set('ck_claveClicked', String(Date.now()));
        store.set('ck_claveSamlErrs', '0'); // SAML page loaded fine — reset error streak
        claveBadge(L('нажала eIdentifier ✓ — Chrome подтянет сертификат', 'clicked eIdentifier ✓ — Chrome will select certificate'), '#7CFC00');
        clearInterval(timer);
      } else if (tries > 40) { // ~20 секунд ожидания медленной страницы
        claveBadge(L('кнопку eIdentifier не нашла — выбери вручную', 'eIdentifier button not found — please select manually'), '#ff8888');
        clearInterval(timer);
      }
    }, 500);
  }

  function boot() {
    // на домене Cl@ve полный чекер не нужен — только выбрать сертификатный путь
    if (onClavePlatform) { clavePlatformFlow(); return; }
    panel();
    // страница перезагрузилась — значит прошлый клик Volver (если был) сработал:
    // сносим его служебные метки. viaVolver НЕ трогаем: она нужна nocitas-ветке
    // на этой же цепочке проверок (метка ↩ в журнале).
    SS.del('volverAt'); SS.del('volverTries');
    // v9.0: ✋-пауза ушла. Если страница пришла с паузой — проверка не идёт:
    // молча продолжать ритм нельзя. Заодно сносим протухшие ключи старых версий.
    if (SS.get('paused') === '1') SS.del('on');
    SS.del('paused'); SS.del('boostUntil');
    // v9.1: грейс-пауза после ручной загрузки удалена (в v9.0 автозапуска нет —
    // каждый заход в проверку начинается кнопкой, ⏹ всегда под рукой). Её ключ
    // и метку autoNav сносим как протухшие.
    SS.del('graceUntil'); SS.del('autoNav');
    restoreClaveSession();
    if (CONFIG.FORCE_FOUND && driving()) SS.set('found', '1');
    // v8.3: сюда дошли осознанно (кнопка «Проверить сейчас» ушла отсюда
    // Volver'ом или перезаходом) — ведём форму сразу, не ждём расписания
    // ритма: nextAt от прошлой проверки запер бы tick через waiting. Метку
    // едим безусловно — с выключенным чекером она просто не должна жить.
    if (SS.get('forceNow')) { SS.del('forceNow'); SS.del('nextAt'); }
    if (driving()) {
      pingHelper();
      const nextAt = parseInt(SS.get('nextAt') || '0', 10);
      if (nextAt > Date.now()) waiting = true; // мы на паузе между проверками
      else if (nextAt) SS.del('nextAt'); // расписание исполнено этой загрузкой
      sendBeat();
      setInterval(sendBeat, 60000); // пульс сторожу раз в минуту
    }
    setInterval(() => { if (!stepMode()) tick(); }, 600); // в пошаговом режиме — только по кнопке
    setInterval(heartbeat, 1000);
    setInterval(watchdog, 3000);
    // клик/фокус мгновенно оживляют вкладку после заморозки Chrome:
    // если проверка просрочена (вкладку морозили) — сразу открываем форму заново
    function onWake() {
      if (!driving() || stepMode()) return;
      const nextAt = parseInt(SS.get('nextAt') || '0', 10);
      if (nextAt && Date.now() >= nextAt && !recently('wakeReload', 5000)) {
        SS.del('nextAt'); waiting = false;
        recordResult('RESUMED'); // видно в журнале, что вкладку морозило
        status(L('🔄 Вкладка ожила — начинаю следующую проверку…', '🔄 Tab woke up — starting next check…'));
        startNewCheck();
      } else {
        heartbeat();
      }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onWake(); });
    window.addEventListener('focus', onWake);
    // v9.4: «назад» из кэша (bfcache): boot() не выполняется, состояние
    // страницы протухло (waiting=false с тех пор, как проверка шла).
    // Пересобираем паузу из расписания и показываем честный отсчёт;
    // tick дополнительно сам сверяется с расписанием (schedulePending).
    window.addEventListener('pageshow', (ev) => {
      if (!ev.persisted) return; // обычная загрузка — boot() всё сделал сам
      if (schedulePending()) { waiting = true; stopped = false; heartbeat(); }
    });
    if (!stepMode()) tick(); // в пошаговом режиме первый шаг — тоже по кнопке
    heartbeat();
  }
  if (document.body) boot();
  else window.addEventListener('DOMContentLoaded', boot);
})();
