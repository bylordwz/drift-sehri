# Drift Şehri

Tarayıcıda ve mobilde oynanan, üstten görünüşlü 2D açık dünya şehir ve drift oyunu (GTA 1/2 ve Chinatown Wars tarzı). Kurulum veya bağımlılık gerektirmez; saf HTML5 Canvas, JavaScript ve WebAudio ile yazıldı. Oynanış hissi mobil drift oyunu FR Legends'tan esinlenir (gaz/fren/el freni pedalları, debriyaj atma, açı-hız-yakınlık puanlaması, tandem takip). Oyundan hiçbir görsel, isim veya marka kullanılmamıştır.

## Oynamak

`index.html` dosyasını bir web sunucusu üzerinden açın:

```bash
python3 -m http.server 8000
# tarayıcıda: http://localhost:8000
```

GitHub Pages ile yayınlamak için: Settings → Pages → Source: `main` dalı, kök klasör. Telefonda açıp "Ana ekrana ekle" ile tam ekran oynanabilir.

## Modlar

- **Açık Şehir (ana mod):** Şehirde yürü, istediğin aracı çal, trafikte drift at, polisten kaç, görev al.
  - **Yaya ve araç:** yürü/koş, park etmiş araçları veya trafikteki araçları çal (sürücü kaçar). Kendi garaj aracın güvenli evin önünde bekler.
  - **Yaşayan şehir:** sağdan akan trafik (trafik ışıkları, göbekler, korna, sirene yol verme), kaldırımda yürüyen ve yaya geçidinden geçen yayalar.
  - **Aranma (5 yıldız):** suç işlerken polis veya yayalar görürse yıldız artar. Polis arabaları kovalar, sıkıştırır ve çarpar; yaya polisler tutuklar (**ENSELENDİN!**). Görüş dışında kalarak, yıldız sayısı kadar polis aracını çarpıp devre dışı bırakarak ya da **boyahaneye** girerek kurtulursun.
    - **3 yıldız ve üstü — barikat:** polis, gittiğin yönde 90–150 m ileride, görüş dışındaki bir noktada iki polis aracıyla yolu keser (5 yıldızda iki barikat). Ortada dar bir boşluk kalır; araçları itebilir ya da çarpıp geçebilirsin.
    - **4 yıldız ve üstü — çivi şeridi ve helikopter:** barikat boşluğuna çivi şeridi serilir. Üstünden geçersen **LASTİKLER PATLADI!**: tutuş ve son hız düşer, araç yalpalar. Lastikler boyahanede, garajda ya da araç değiştirince düzelir. Polis helikopteri tepende döner; ışıldağının altında kalırsan binalar seni saklamaz.
  - **Hasar:** araçlar duman → alev → çizgi film patlaması aşamalarından geçer. Can biterse **BAYILDIN!** (hastane ücreti). Kan ve ölüm yok.
  - **Görevler:** 12 ankesörlü telefonda 3 ekibin 12 görevi (teslimat, kırılgan kargo, sipariş araç çalıp vince götürme, şehir içi drift, kontrol noktalı yarış, polisten kaçış). Ayrıca drift/yarış etkinlik noktaları ve taksi işi var. Madalyalar, saygınlık ve "TEKRAR DENE" de var.
  - **Yan işler:** herhangi bir polis aracına binip **E — Polis işi (POLİS İŞİ)** ile kaçan şüphelileri yakala (çarparak durdur ya da sıkıştır; şüphelilere çarpmak suç sayılmaz). Hastanenin yanındaki ambulansla **E — Ambulans işi (AMBULANS İŞİ)** yaralıları topla, hastaneye yetiştir (en çok 3 hasta). Karakolun ve hastanenin önünde birer servis aracı park hâlinde bekler; trafikte de ambulans görebilirsin (Orta ve Yüksek kalitede).
  - **Eşyalar:** şehre dağılmış 28 eşya: **can** (+50), **zırh** (+50, en çok 100; hasarın üçte ikisini emer), **rüşvet rozeti** (−1 yıldız), **tamir anahtarı** (araç hasarı +%50, araçta), **nitro** (10 saniye +%30 tork, araçta), **para çantası** (₺100–400) ve **kefalet kartı** (bir sonraki enselenme cezasız: "KEFALET KARTI KULLANILDI"). Alınan eşya birkaç dakika sonra yeniden çıkar. Yakındaki eşyalar mini haritada görünür.
  - **50 gizli paket:** park köşelerinde, binaların arkasında, ara sokaklarda, sanayide ve drift parkının kenarlarında saklı küçük "?" kasaları. Her biri ₺100; her 10 pakette büyük ikramiye, 50'sinin hepsine ₺50.000. Haritada gösterilmezler; kaç tane bulduğun duraklatma kartında yazar ("Gizli paket: n/50").
  - **Araç radyosu:** araca binince radyo çalar; müzik prosedürel olarak üretilir ve sürekli değişir. İstasyonlar: **Drift FM** (synthwave), **Sokak Beat** (house), **Lo-Fi Gece** (lo-fi hip-hop), **Saz Wave** (hicaz/uşşak makamında saz ve darbuka) ve **Kapalı**. İstasyon değişince adı ekranın üstünde 2 saniye görünür. Ses düzeyi Ayarlar → **Radyo sesi**.
  - **Diğer:** gün/gece döngüsü, GPS rotası, tam ekran harita (yol noktası koyma), güvenli evde otomatik kayıt ve garaj.
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

### Açık Şehir kontrolleri

| İşlem | Dokunmatik | Klavye | Oyun kumandası |
|---|---|---|---|
| Yürü / koş | Sol yüzen joystick (sonuna kadar it: koş) | W A S D / oklar, Shift koş | Sol çubuk, A koş |
| İt (yumruk) | İT | Boşluk | B |
| Araca bin / in | BİN / İN | F / Enter | Y |
| Telefon, görev başlat, taksi, garaj | ETKİLEŞ | E | X (araçta D-pad yukarı) |
| Korna | KORNA | H | L3 |
| Harita | HARİTA veya mini haritaya dokun | M / Tab | Back |
| Radyo istasyonu (araçta) | RADYO | T (Y: önceki) | D-pad sağ |
| Polis işi / ambulans işi (polis aracında / ambulansta) | POLİS İŞİ / AMBULANS | E | D-pad yukarı |

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
- **Ses** (`js/audio.js`): Motor sesleri (4 silindir, turbo 4, sıralı 6, rotary, V8) WebAudio osilatörleriyle sentezleniyor. Lastik çığlığı, turbo ıslığı, blow-off, egzoz patlaması, çarpışma, siren ve helikopter pervanesi sesleri de var.
- **Radyo** (`js/radio.js`): "iki saat" yöntemiyle ses saatine göre en fazla ~0,1 s ileriye nota yerleştiriliyor. Davul sesleri bir kez sentezlenip yeniden kullanılıyor, her melodi partisi tek bir uzun ömürlü ses kaynağı. Düşük kalitede ses sayısı azalıyor, yankı ve gecikme kapanıyor.
- **Performans:** en düşük kalite kademesi (Çok düşük), 4 kat yavaşlatılmış işlemcide 1280×720 gece sahnesinde yaklaşık 30 FPS hedefleniyor. Helikopter, eşyalar ve radyo her kademede açık; Çok düşük kademede eşya parlaması kapalı.

## Dosyalar

```
index.html            arayüz iskeleti
css/style.css         görünüm, mobil düzen
js/util.js            yardımcılar
js/data.js            araçlar, parçalar, paletler
js/vehicles.js        açık şehir araçları (sedan, taksi, polis, kamyonet, kamyon, spor, ambulans), yaya paletleri
js/quality.js         grafik kalite kademeleri, otomatik kalite
js/collide.js         OBB çarpışma ve impuls çözümü
js/city.js            şehir üretimi, çizimi, çarpışma ızgarası
js/car.js             araç fiziği ve çizimi
js/fx.js              parçacıklar, lastik izi, yağmur
js/audio.js           ses sentezi
js/input.js           klavye, dokunmatik, eğim, kumanda
js/score.js           drift puanlama
js/tandem.js          yapay zekâ lider ve hakem
js/ui.js              menüler, garaj, göstergeler
js/nav.js             şerit grafiği, yaya grafiği, trafik ışıkları, görüş hattı, rota (A*)
js/actors.js          araç/yaya sprite önbelleği, işaretler
js/traffic.js         trafik yapay zekâsı ve araç kayıtları
js/peds.js            yayalar ve yaya oyuncu
js/police.js          aranma seviyesi, polis yapay zekâsı, tutuklama, barikat, çivi şeridi, helikopter
js/missions.js        görevler, ekipler, taksi, etkinlikler, polis işi, ambulans işi
js/pickups.js         eşyalar (can, zırh, rüşvet, tamir, nitro, para, kefalet kartı) ve 50 gizli paket
js/radio.js           prosedürel araç radyosu (5 istasyon)
js/world.js           açık dünya çekirdeği (bin/in, hasar, kayıt, gün/gece, GPS)
js/hud.js             açık şehir göstergeleri, harita, telefon ekranı
js/main.js            oyun döngüsü, kamera, katmanlı çizim
```
