# VTT Server Hosting Rehberi

Uygulamayı canlı bir sunucuya (VPS, VDS veya Node.js destekli Hosting) yüklediğinizde Node.js (VTT) sunucusunun arka planda 7/24 kesintisiz çalışması için aşağıdaki adımları izleyebilirsiniz.

## 1. Domain / URL Ayarı
`includes/config.php` dosyasını açın ve en alt satırdaki `WS_URL` değişkenini canlı sitenizin VTT adresine göre güncelleyin.
Örnek:
`define('WS_URL', 'https://vtt.siteniz.com');` veya `define('WS_URL', 'https://siteniz.com:3000');`

## 2. Gerekli Kurulumlar (Sunucuda)
Sunucunuza SSH ile bağlanıp `vtt-server` klasörüne girin ve Node modüllerini yükleyin:
```bash
npm install
```

## 3. PM2 ile Arka Planda Başlatma
Sunucunuzda PM2 (Process Manager) yüklü değilse global olarak kurun:
```bash
npm install pm2 -g
```

Ardından VTT sunucusunu `ecosystem.config.js` dosyasını kullanarak arka planda (production modunda) başlatın:
```bash
pm2 start ecosystem.config.js --env production
```

## 4. Yeniden Başlatmalarda Otomatik Çalışması (Opsiyonel)
Sunucu (makine) yeniden başladığında uygulamanın da otomatik kalkması için:
```bash
pm2 startup
pm2 save
```

## Not
Sunucunuzun güvenlik duvarında (Firewall/UFW/iptables) veya Hosting panelinizde `3000` numaralı portun (veya ecosystem'de hangi portu belirlediyseniz) dışarıya açık olduğundan emin olun!
