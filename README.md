# AlexCasino Community Site — Final Test Build

Полная версия для тестирования всех основных механик в одном приложении.

## Что работает

- Age gate 18+ с редиректом в Telegram при "Нет"
- Авторизация с cookie-сессией (`/api/auth/login`, `/api/auth/me`, `/api/auth/logout`)
- Профиль пользователя (`kickUsername`, `telegram`, `shuffleNick`)
- Флаги мультиакка при совпадении Telegram/Shuffle nick
- Баланс поинтов из Botrix
- Leaderboard из Shuffle (месяц по `Europe/Moscow`, top-20)
- Розыгрыши: create/join/close
- Предикты: create/submit/close + победитель по closest/timestamp
- Поддержка: создание тикетов пользователем + просмотр в админке
- Админка: аудит, флаги, список пользователей, изменение роли/банов/кастомных пермишенов

## Быстрый старт

```bash
npm start
```

Открыть: `http://localhost:3000`

## Тестовые аккаунты

### Superadmin
- provider: `telegram`
- providerId: `owner`

### Обычный пользователь
- любой другой provider/providerId

## ENV

- `PORT` (default `3000`)
- `SHUFFLE_URL` (default встроен)
- `BOTRIX_CHANNEL` (default `alexcasino`)
- `BOTRIX_SECRET` (если указать, включится реальное списание поинтов через Botrix extension endpoint)
- `BOTRIX_UID_FIELD` (default `username`)

## Важно

Вход пока MVP-режим (без реального OAuth handshake). Для боевого деплоя следующий шаг: подключить официальный Kick OAuth + Telegram login widget и хранение секретов в vault.
