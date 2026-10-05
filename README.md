# Drift Şehri

Tarayıcıda ve mobilde oynanan, üstten görünüşlü 2D şehir içi drift oyunu. Kurulum veya bağımlılık gerektirmez; saf HTML5 Canvas, JavaScript ve WebAudio ile yazıldı. Oynanış hissi mobil drift oyunu FR Legends'tan esinlenir (gaz/fren/el freni pedalları, debriyaj atma, açı-hız-yakınlık puanlaması, tandem takip). Oyundan hiçbir görsel, isim veya marka kullanılmamıştır.

## Oynamak

`index.html` dosyasını bir web sunucusu üzerinden açın:

```bash
python3 -m http.server 8000
# tarayıcıda: http://localhost:8000
```

GitHub Pages ile yayınlamak için: Settings → Pages → Source: `main` dalı, kök klasör. Telefonda açıp "Ana ekrana ekle" ile tam ekran oynanabilir.

## Modlar

- **Serbest sürüş:** 9×9 bloklu şehirde dolaş, drift kombosu kur. Drift parkında sekiz çizmek için iki lastik adası, klip noktaları ve dubalar var.
- **Tandem:** Şehir sokaklarında drift atan yapay zekâ lideri takip et. Hakem yakınlığı (2–9 m ideal), açı uyumunu ve çizgiyi puanlar. 65 puan üstü kazanır, temas ve lideri geçmek ceza alır.
- **Garaj:** 5 araç (HACHI, KUMO, KAZE, ONI, RONIN), boya, kaplama, jant, arka kanat, alt neon, duman rengi ve performans parçaları (motor, turbo, lastik, açı kiti, diferansiyel).

## Kontroller

| İşlem | Dokunmatik | Klavye | Oyun kumandası |
|---|---|---|---|
| Direksiyon | ◀ ▶ butonları, kaydırıcı veya eğim | ← → / A D | Sol çubuk |
| Gaz | GAZ pedalı | ↑ / W | RT |
| Fren / geri | FREN pedalı (dururken basılı tut: geri vites) | ↓ / S | LT |
| El freni | EL FRENİ | Boşluk | A / B |
| Debriyaj atma | Gaza hızlıca iki kez dokun | Shift | X |
| Vites (manuel) | + / − | E / Q | RB / LB |
| Kamera, yola dön, duraklat | — | C, R, P / Esc | Select, Y, Start |

## Puanlama

- Drift puanı saniyede **açı × hız × çarpan** olarak birikir.
- Çarpan, kesintisiz drift sürdükçe ve her yön değiştirmede (geçiş) artar.
- Duvara 1,4 m'den yakın drift (**YAKIN**) puanı 1,8 katına çıkarır. Klip noktasından geçmek bonus verir.
- Araç düzelince kombo kasaya yatar. Sert çarpma veya spin komboyu sıfırlar.
- Kasaya yatan her 10 puan 1 ₺ eder.

## Teknik notlar

- **Fizik** (`js/car.js`): 120 Hz sabit adımlı iki tekerlekli (bisiklet) araç modeli kullanılıyor.
  - Ön ve arka kayma açıları Pacejka benzeri lastik eğrisinden geçiyor.
  - Arka aksta sürtünme çemberiyle tahrik ve yanal kuvvet paylaşılıyor.
  - Ağırlık transferi, el freninde kilitlenen arka tekerler, debriyaj atma, turbo gecikmesi, devir sınırlayıcı ve otomatik/manuel şanzıman var.
  - "Drift yardımı" iki parçadan oluşuyor: otomatik kontra ve kayma açısı değişimini sönümleyen dengeleyici.
- **Şehir** (`js/city.js`): Tohumlu prosedürel üretimle yollar, kaldırımlar, binalar, park, otopark, sanayi bölgesi, drift parkı ve göbek kavşaklar oluşturuluyor. Binalar kamera noktasından ölçeklenen sözde-3D duvarlarla çiziliyor (GTA 2 tarzı).
- **Efektler** (`js/fx.js`): lastik dumanı, kalıcı lastik izi katmanı, kıvılcım, egzoz alevi, kırılan direk ve bidon parçaları, yangın musluğu fıskiyesi ve yağmur var. Gece ışık haritası çarpma ve toplama karışımıyla sodyum lambaları, farları, stop lambalarını, neon tabelaları ve aydınlatılmış dumanı birleştiriyor.
- **Ses** (`js/audio.js`): Motor sesleri (4 silindir, turbo 4, sıralı 6, rotary, V8) WebAudio osilatörleriyle sentezleniyor. Lastik çığlığı, turbo ıslığı, blow-off, egzoz patlaması ve çarpışma sesleri de var.

## Dosyalar

```
index.html            arayüz iskeleti
css/style.css         görünüm, mobil düzen
js/util.js            yardımcılar
js/data.js            araçlar, parçalar, paletler
js/collide.js         OBB çarpışma ve impuls çözümü
js/city.js            şehir üretimi, çizimi, çarpışma ızgarası
js/car.js             araç fiziği ve çizimi
js/fx.js              parçacıklar, lastik izi, yağmur
js/audio.js           ses sentezi
js/input.js           klavye, dokunmatik, eğim, kumanda
js/score.js           drift puanlama
js/tandem.js          yapay zekâ lider ve hakem
js/ui.js              menüler, garaj, göstergeler
js/main.js            oyun döngüsü, kamera, katmanlı çizim
```
