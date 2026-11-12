# Cita Por Favor — Public Release Changelog (EN / RU)

Only public release changes are listed here. No personal data or private diagnostic logs are included.

---

## 9.25.5 — Cl@ve SAML Error Auto-Recovery & F5 WAF Booking Pace Fixes

### English
- **Cl@ve SAML Error Auto-Recovery (`pasarela.clave.gob.es`)**: When the Cl@ve gateway fails with `Invalid session for the SAML request` or `Se ha producido un error`, the script now automatically detects the error, waits 6 seconds, and redirects back to the appointment start page to cleanly restart from Step 1. Includes a 3-strike circuit breaker (stops and alerts if Cl@ve fails 3 times in a row) and logs any SAML bounce in the check journal.
- **Humanized Office & Slot Selection Pace**: Increased the post-selection delay before clicking `Siguiente` on Step 3.5 (`#idSede` office selection) and Step 4 (`rdbCita` slot selection) from a fixed `700 ms` (`0.7s`) to a randomized `1400–2200 ms` (`1.4–2.2s`) so the F5 BIG-IP firewall does not reject `acVerFormulario` when slots appear.
- **Humanized Contact Form Pace (`acOfertarCita`)**: Restored `contactFillMinSec` / `contactFillMaxSec` on Step 5 (Phone & Email) from `0.5–1.0s` back to the natural `0.9–1.9s` per field (~5–6s total) so F5 WAF does not block `/acOfertarCita` when submitting contact details.
- **Safe Default Boost Interval (`145s`)**: Updated the default Boost interval (`boostSec`) from `60s` to `145s` (with a one-time migration for `<145s`) so continuous Boost with `±15%` jitter stays safely within the `≤5 checks per 11 minutes` WAF limit.

### Русский
- **Авто-восстановление при ошибке SAML на Cl@ve (`pasarela.clave.gob.es`)**: если шлюз Cl@ve выдаёт `Invalid session for the SAML request` / `Se ha producido un error`, скрипт ждёт 6 секунд и автоматически возвращает вкладку на стартовую страницу записи для чистого перезапуска с Шага 1 (с отсечкой после 3 ошибок подряд и записью в журнал).
- **Человеческая пауза при выборе офиса и слота**: задержка перед нажатием `Siguiente` на Шаге 3.5 (`#idSede`) и Шаге 4 (`rdbCita`) увеличена с фиксированных `0.7 с` до случайных `1.4–2.2 с`, чтобы файрвол F5 не отклонял `acVerFormulario` в момент находки.
- **Человеческий темп ввода телефона и почты (`acOfertarCita`)**: паузы `contactFillMinSec` / `contactFillMaxSec` на Шаге 5 возвращены с `0.5–1.0 с` к безопасным `0.9–1.9 с` между полями, чтобы F5 WAF не блокировал отправку контактов (`/acOfertarCita`).
- **Безопасный интервал Форсажа по умолчанию (`145 с`)**: дефолтный интервал `boostSec` увеличен с `60 с` до `145 с` (с разовой миграцией старых значений `<145 с`), чтобы при включённом форсаже темп с учётом разброса `±15%` не превышал порог WAF (≤5 проверок за 11 минут).

---

## 9.25.1 — Step-by-Step Mode & Certificate Login Fixes / Фиксы пошагового режима и входа сертификатом

### English
- **Step-by-Step Mode**: The applicant details and phone/email screens now fill step-by-step when clicking "Next Step" (Copy → fields/country → submit).
- **Digital Certificate Login (`eIdentifier`)**: If the Chrome certificate selection dialog is not confirmed in time and the first screen loops, the checker no longer stops immediately — it calls via voice alert ("Please confirm your digital certificate in the Chrome dialog"), waits, and retries later. Auto-clicking `eIdentifier` now also works on fast returns from the Cl@ve gateway.
- **Setup Guide**: Added instructions for fixing `NET::ERR_CERT_AUTHORITY_INVALID` (missing intermediate certificate chain) on Windows and macOS.

### Русский
- Пошаговый режим: экраны заявителя и телефона теперь заполняются по кнопке «Следующий шаг» — по одному шагу за нажатие (Copiar → поля/страна → отправка). Раньше заполнение в пошаговом режиме молча не работало.
- Вход сертификатом (eIdentifier): если окно Chrome с выбором сертификата не подтверждено и первый экран сайта уходит по кругу, чекер больше не останавливается сразу — голосом позовёт «Подтверди сертификат в окне Chrome», подождёт и повторит проверку позже. Авто-клик eIdentifier теперь срабатывает и при быстром возврате с платформы Cl@ve.
- Добавлен раздел SETUP про ошибку «Ваше подключение не защищено» (неполная цепочка сертификата сайта) с лечением для Windows и macOS.

---

## 9.25 — Asignación de NIE Service / Услуга asignación de NIE

### English
- **New service `ASIGNACIÓN DE NIE (Policía — first-time NIE number)`**: Checkbox in "Search Settings", rotates with other selected services as usual. Select "PASSPORT" in "Edit My Personal Details" when booking this service.
- **Autofill fix**: Selecting "PASSPORT" now properly clicks the document type radio button before filling the passport number.

### Русский
- Новая услуга «ASIGNACIÓN DE NIE (Policía — первое получение номера)» — первичное назначение номера NIE: галочка в «Настройках поиска», чередуется с остальными услугами как обычно. Для записи по этой услуге в «Изменить мои данные» выберите документ «Паспорт» — NIE у заявителя ещё нет.
- Фикс заполнения: при выборе «Паспорт» поле номера документа на сайте оставалось в формате N.I.E. и не принимало номер — теперь тип документа выбирается настоящим кликом, номер подставляется сразу.
- Спасибо за идею и проверку беты — Milana R.

---

## 9.24 — Booking for Another Person via Cl@ve / Запись другому человеку при входе через Cl@ve

### English
- When logging in via Cl@ve / certificate, you can now choose **"Booking appointment for"**: *"Myself (Cl@ve owner)"* or *"Another person (from 'My Personal Details')"*. When booking for another person, "Copiar a datos solicitante" is skipped and the applicant's name, NIE/passport, and birth year are filled from "My Personal Details".

### Русский
- При входе через Cl@ve/сертификат скрипт больше не привязан к владельцу: в «Настройках поиска» появился выбор «Кому записываемся» — «Себе (владелец Cl@ve)», как раньше, или «Другому человеку (из «Мои данные»)». При выборе «другому» кнопка «Copiar a datos solicitante» не нажимается, а имя, NIE и год рождения заявителя вписываются из «Моих данных»: своим сертификатом можно записать партнёра или члена семьи.
- Спасибо за идею и первую реализацию — Konstantin Chukreev (chukrello, PR #2).

---

## 9.23 — Recogida de Tarjeta (TIE) & Confirmation Screen / Услуга recogida de tarjeta и экран подтверждения

### English
- Added **`RECOGIDA DE TARJETA (TIE)`** service for picking up ready TIE cards.
- Recognizes the **`CITA CONFIRMADA`** screen after clicking Confirmar: shows green confirmed status, stops checking, silences voice alerts, and logs the confirmation.

### Русский
- Новая услуга «RECOGIDA DE TARJETA (TIE)» — получение готовой карточки: в некоторых отделениях на это тоже нужна сита. Галочка — в «Настройках поиска», чередуется с остальными услугами как обычно.
- Экран «CITA CONFIRMADA» после Confirmar теперь распознаётся: зелёный статус «СИТА ПОДТВЕРЖДЕНА», тихая остановка проверки, запись в журнал.
- Любая остановка проверки теперь гарантированно глушит голосовое оповещение.

---

## 9.22 — Multi-Office Selection / Выбор офисов галочками

### English
- Replaced single-office dropdown with checkboxes in **"Office Selection"**: none checked = whole province (any office); 1 checked = checks only that office; 2+ checked = checks whole province (`Cualquier oficina`) and books only selected offices (with optional *"If selected offices have no slots — take any"* fallback).

### Русский
- Секция «Офисы, которые проверяем»: вместо одного офиса из списка — галочки. Ничего не отмечено = вся провинция (запишетесь в любой офис со свободным слотом); один офис = проверка только его; два и больше = каждый заход проверяет всю провинцию, но записывает только в отмеченные офисы — чужие пропускает и продолжает проверку.
- Галка «Если выбранных офисов нет — брать любой» (видна при двух и более отмеченных офисах) разрешает записаться в любой предложенный офис.
- Записывать вас в чужой офис без этой галки скрипт больше не будет.

---

## 9.21 — Support & Feedback / Поддержка и обратная связь

### English
- Added support link at the bottom of the panel, GitHub Discussions links, document type selector (`NIE` / `PASSPORT`), and empty default country field.

### Русский
- Внизу панели появилась компактная кнопка «Написать в поддержку».
- В README и инструкции добавлены ссылки на GitHub Discussions и правила безопасной диагностики без личных данных.
- Тип документа выбирается из списка: NIE или PASSPORT.
- Страна больше не имеет значения по умолчанию: её задаёт сам пользователь.

---

## 9.20 — Initial Public Release / Первый публичный выпуск

### English
- Published Cita Por Favor as a local userscript for checking Extranjería appointment availability in Barcelona, along with setup, privacy, and safe-use guides.

### Русский
- Cita Por Favor опубликован как локальный userscript для проверки доступности citas в Барселоне.
- Добавлены публичные инструкции, правила приватности и безопасного использования.
