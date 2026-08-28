# Яндекс Метрика

Счётчик: `112046844`.

Инициализация находится в `public/app.js`, потому что сайт использует строгий Content Security Policy. В `views/partials/head.ejs` оставлен `noscript`-пиксель, а разрешённые адреса Метрики и Вебвизора перечислены в CSP в `src/server.ts`.

События не передают email, имена, города доставки, комментарии, поисковые фразы или другие введённые посетителем строки. В параметрах остаются только технический контекст, роль, числовой ID публичной сущности и укрупнённые диапазоны. Все `input` и `textarea` автоматически получают класс `ym-disable-keys`, поэтому Вебвизор маскирует содержимое полей.

## Основные цели воронки

| Идентификатор | Когда отправляется | Полезные параметры |
| --- | --- | --- |
| `registration_cta_click` | Клик по CTA регистрации | `role`, `placement` |
| `registration_start` | Открыта форма регистрации | `role` |
| `registration_submit` | Валидная форма отправлена | `role` |
| `registration_success` | Сервер действительно создал аккаунт | `role` |
| `catalog_search` | Поиск или применение фильтров | `form_source`, `filters_count`, `has_query` |
| `supplier_card_open` | Переход из карточки каталога | `apiary_id`, `placement` |
| `supplier_view` | Открыта страница поставщика | `apiary_id`, `demo`, `verified`, `has_lots` |
| `lot_request_start` | Выбрана конкретная партия для заявки | `apiary_id`, `specific_lot` |
| `inquiry_submit` | Валидная заявка отправлена на сервер | `apiary_id`, `specific_lot`, `volume_bucket` |
| `inquiry_success` | Сервер создал заявку | `role` |
| `favorite_added` | Поставщик действительно добавлен в избранное | `role` |

## Активация и контент

| Идентификатор | Когда отправляется |
| --- | --- |
| `supplier_profile_published` | Поставщик впервые переводит профиль из черновика в опубликованный |
| `lot_created` | Поставщик успешно создаёт партию |
| `join_page_view` | Просмотр посадочной для магазина или пасеки; параметр `audience` |
| `engaged_visit` | Не менее 30 видимых секунд и 25% страницы |
| `publication_read` | Не менее 45 видимых секунд и 60% публикации |
| `catalog_sort` | Изменена сортировка каталога |
| `login_submit` | Валидная форма входа отправлена |
| `login_success` | Сервер подтвердил вход; параметр `role` |

## Настройка в интерфейсе Метрики

Для конверсий создайте цели типа «JavaScript-событие» с точными идентификаторами из таблицы. В первую очередь достаточно шести: `registration_success`, `catalog_search`, `supplier_view`, `lot_request_start`, `inquiry_success`, `supplier_profile_published`.

События `*_submit` показывают потери между нажатием кнопки и подтверждённым сервером результатом. Главными конверсиями следует считать только `*_success`.

Для ручной проверки в консоли браузера доступны:

```js
window.pchelaMetrika.counterId
window.pchelaMetrika.reachGoal('catalog_search', { form_source: 'manual_check' })
```
