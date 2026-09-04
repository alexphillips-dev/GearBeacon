import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type Product = {
  slug: string;
  name: string;
  category: string;
  imageUrl?: string | null;
  price: string | null;
  status: string;
  inStock: boolean;
  comingSoon: boolean;
  restockEtaAt?: string | null;
  soldOutAt?: string | null;
  url: string;
  watched: boolean;
};

type StockEvent = {
  id: string;
  type: 'restock' | 'sold_out' | 'price_change' | 'status_change' | 'new_product';
  slug: string;
  name: string;
  price: string | null;
  detectedAt: string;
  watchedAtDetection: boolean;
  url: string;
};

type ApiStatus = {
  version: string;
  region: string;
  regionLabel: string;
  pollSeconds: number;
  productCount: number;
  checking: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  mockMode: boolean;
  storage?: { engine: string; schemaVersion: number; userDataDir: string };
  notifications: { expoPushDevices: number; ntfyConfigured: boolean; discordConfigured: boolean; preferences?: NotificationPreferences };
  health?: { ok: boolean; stale: boolean; staleAfterSeconds: number };
  catalogHealth?: string;
  consecutiveFailures?: number;
};

type NotificationPreferences = {
  restock: boolean;
  soldOut: boolean;
  priceChange: boolean;
  statusChange: boolean;
  newProduct: boolean;
};

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  restock: true,
  soldOut: false,
  priceChange: false,
  statusChange: false,
  newProduct: false,
};

type DataInfo = {
  engine: string;
  userDataDir: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  backup: { count: number; retention: number; latest?: { name: string; createdAt: string } | null };
};

type Tab = 'watchlist' | 'browse' | 'activity' | 'settings';
const API_STORAGE_KEY = 'gearbeacon.apiBaseUrl';
const PUSH_TOKEN_STORAGE_KEY = 'gearbeacon.expoPushToken';
const DEFAULT_API = String(Constants.expoConfig?.extra?.apiBaseUrl || 'http://192.168.1.100:8787');
const CATEGORY_ORDER = ['Cloud Gateways', 'Switching', 'WiFi', 'Cameras & Physical Security', 'Door Access', 'Integrations', 'Accessories & Cables', 'Network Storage'];
type ThemeMode = 'dark' | 'light';
type Palette = {
  bg: string; panel: string; panel2: string; panel3: string; border: string; text: string; muted: string; muted2: string;
  accent: string; accentSoft: string; good: string; bad: string; warn: string; image: string; input: string; button: string;
  primary: string; primaryText: string; storeBg: string; storeCard: string; storeText: string; storeMuted: string; storeLine: string;
};
const THEME_STORAGE_KEY = 'gearbeacon.theme';
const DARK: Palette = {
  bg:'#090b0c', panel:'#151718', panel2:'#1a1c1d', panel3:'#202223', border:'#343738', text:'#f2f1ee', muted:'#aaa49a', muted2:'#7f7b75',
  accent:'#d1c3ae', accentSoft:'#2c2924', good:'#2ee581', bad:'#ef6a72', warn:'#d8b76d', image:'#1d1f20', input:'#1b1d1e', button:'#1b1d1e',
  primary:'#efede8', primaryText:'#171817', storeBg:'#171919', storeCard:'#171919', storeText:'#f2f1ee', storeMuted:'#b4aa9c', storeLine:'#343637',
};
const LIGHT: Palette = {
  bg:'#f4f4f2', panel:'#ffffff', panel2:'#f7f7f5', panel3:'#efefec', border:'#d8d9d5', text:'#171817', muted:'#71736f', muted2:'#969791',
  accent:'#6c6255', accentSoft:'#eeeae3', good:'#17884c', bad:'#a6474f', warn:'#92701e', image:'#f3f4f2', input:'#fafaf8', button:'#ffffff',
  primary:'#191a19', primaryText:'#ffffff', storeBg:'#ffffff', storeCard:'#ffffff', storeText:'#171817', storeMuted:'#73756f', storeLine:'#e0e1dd',
};

function trimUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}
function relativeTime(iso?: string | null) {
  if (!iso) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return hr < 24 ? `${hr}h ago` : new Date(iso).toLocaleDateString();
}
function productDetail(item: Product) {
  if (item.inStock) return 'Available now';
  if (item.restockEtaAt) return `Store ETA ${new Date(item.restockEtaAt).toLocaleDateString()}`;
  if (item.comingSoon) return 'Coming soon';
  if (item.soldOutAt) return `Sold out ${relativeTime(item.soldOutAt)}`;
  return 'Waiting for restock';
}

function ProductImage({ item, store = false, styles }: { item: Product; store?: boolean; styles: ReturnType<typeof createStyles> }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hasImage = Boolean(item.imageUrl) && !failed;
  return (
    <View style={store ? styles.storeMedia : styles.watchMedia}>
      {!loaded || !hasImage ? <View style={styles.imagePlaceholder} /> : null}
      {hasImage ? (
        <Image
          source={{ uri: item.imageUrl! }}
          resizeMode="contain"
          onLoad={() => setLoaded(true)}
          onError={() => { setFailed(true); setLoaded(false); }}
          style={store ? styles.storeProductImage : styles.watchProductImage}
        />
      ) : null}
    </View>
  );
}

export default function App() {
  const { width } = useWindowDimensions();
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
  const colors = themeMode === 'dark' ? DARK : LIGHT;
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>('watchlist');
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [apiDraft, setApiDraft] = useState(DEFAULT_API);
  const [products, setProducts] = useState<Product[]>([]);
  const [events, setEvents] = useState<StockEvent[]>([]);
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [dataInfo, setDataInfo] = useState<DataInfo | null>(null);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [browseCategory, setBrowseCategory] = useState('All');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestEventId = useRef<string | null>(null);
  const browseColumns = width >= 900 ? 4 : width >= 650 ? 3 : 2;

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(API_STORAGE_KEY), AsyncStorage.getItem(THEME_STORAGE_KEY), AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY)]).then(([savedApi, savedTheme, savedPushToken]) => {
      if (savedApi) { setApiBase(savedApi); setApiDraft(savedApi); }
      if (savedTheme === 'light' || savedTheme === 'dark') setThemeMode(savedTheme);
      if (savedPushToken) setPushToken(savedPushToken);
    });
  }, []);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') Linking.openURL(url).catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  async function callApi(path: string, options: RequestInit = {}) {
    const base = trimUrl(apiBase);
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  async function refresh(silent = false) {
    if (!silent) setRefreshing(true);
    try {
      const [statusBody, productBody, eventBody, dataBody, notificationBody] = await Promise.all([
        callApi('/api/status'), callApi('/api/products'), callApi('/api/events?limit=100'), callApi('/api/data/info'), callApi('/api/notifications/preferences'),
      ]);
      const incomingEvents: StockEvent[] = eventBody.events || [];
      if (latestEventId.current) {
        const fresh: StockEvent[] = [];
        for (const event of incomingEvents) {
          if (event.id === latestEventId.current) break;
          fresh.push(event);
        }
        const prefs: NotificationPreferences = notificationBody.preferences || DEFAULT_NOTIFICATION_PREFERENCES;
        for (const event of fresh.reverse()) {
          const allowed = event.type === 'new_product' ? prefs.newProduct : event.watchedAtDetection && (
            (event.type === 'restock' && prefs.restock) ||
            (event.type === 'sold_out' && prefs.soldOut) ||
            (event.type === 'price_change' && prefs.priceChange) ||
            (event.type === 'status_change' && prefs.statusChange)
          );
          // If this phone is registered for remote push, the server owns alert delivery.
          // Local notifications remain a useful Expo-development fallback when it is not.
          if (allowed && !pushToken) {
            const titles: Record<string,string> = {
              restock: `🚨 ${event.name} is back in stock`, sold_out: `${event.name} sold out`,
              price_change: `${event.name} price changed`, status_change: `${event.name} status changed`,
              new_product: `New UniFi product: ${event.name}`,
            };
            await Notifications.scheduleNotificationAsync({
              content: {
                title: titles[event.type] || `GearBeacon: ${event.name}`,
                body: event.price ? `${event.price} · Tap to open the store` : 'Tap to open the store',
                data: { url: event.url, slug: event.slug },
              },
              trigger: null,
            }).catch(() => undefined);
          }
        }
      }
      latestEventId.current = incomingEvents[0]?.id || latestEventId.current;
      setStatus(statusBody);
      setDataInfo(dataBody);
      setNotificationPrefs(notificationBody.preferences || DEFAULT_NOTIFICATION_PREFERENCES);
      setProducts(productBody.products || []);
      setEvents(incomingEvents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(true), 10000);
    return () => clearInterval(timer);
  }, [apiBase]);

  async function toggleWatch(product: Product) {
    try {
      if (product.watched) await callApi(`/api/watch/${encodeURIComponent(product.slug)}`, { method: 'DELETE' });
      else await callApi('/api/watch', { method: 'POST', body: JSON.stringify({ slug: product.slug }) });
      setProducts((items) => items.map((p) => p.slug === product.slug ? { ...p, watched: !p.watched } : p));
    } catch (err) {
      Alert.alert('GearBeacon', err instanceof Error ? err.message : String(err));
    }
  }

  async function forceCheck() {
    setRefreshing(true);
    try { await callApi('/api/check', { method: 'POST' }); await refresh(true); }
    catch (err) { Alert.alert('Check failed', err instanceof Error ? err.message : String(err)); }
    finally { setRefreshing(false); }
  }

  async function checkUpdates() {
    try {
      const result = await callApi('/api/update/check');
      if (result.updateAvailable) {
        Alert.alert(`GearBeacon V${result.latestVersion} available`, result.releaseNotes || 'A newer GearBeacon version is available.', [
          { text: 'Later', style: 'cancel' },
          ...(result.downloadUrl ? [{ text: 'Download', onPress: () => Linking.openURL(result.downloadUrl) }] : []),
        ]);
      } else {
        Alert.alert('GearBeacon is up to date', `V${result.currentVersion} is the latest version on the configured update channel.`);
      }
    } catch (err) {
      Alert.alert('Update check failed', err instanceof Error ? err.message : String(err));
    }
  }

  async function createBackupNow() {
    try {
      await callApi('/api/data/backup', { method: 'POST' });
      const next = await callApi('/api/data/info');
      setDataInfo(next);
      Alert.alert('Backup created', 'GearBeacon saved a safety copy of the SQLite database.');
    } catch (err) {
      Alert.alert('Backup failed', err instanceof Error ? err.message : String(err));
    }
  }

  function openDataTools() {
    Linking.openURL(`${trimUrl(apiBase)}/#settings`).catch(() => Alert.alert('GearBeacon', 'Could not open the server dashboard.'));
  }

  function exportData() {
    Linking.openURL(`${trimUrl(apiBase)}/api/data/export`).catch(() => Alert.alert('GearBeacon', 'Could not open the export download.'));
  }

  async function saveApi() {
    const next = trimUrl(apiDraft);
    if (!/^https?:\/\//i.test(next)) return Alert.alert('Invalid URL', 'Use a full URL such as http://192.168.1.50:8787');
    await AsyncStorage.setItem(API_STORAGE_KEY, next);
    setApiBase(next);
    Alert.alert('Saved', 'GearBeacon will connect to the new server address.');
  }

  async function toggleTheme() {
    const next: ThemeMode = themeMode === 'dark' ? 'light' : 'dark';
    setThemeMode(next);
    await AsyncStorage.setItem(THEME_STORAGE_KEY, next);
  }

  async function enablePush() {
    try {
      if (!Device.isDevice) throw new Error('Remote push notifications require a physical device.');
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('restocks', {
          name: 'Restock alerts',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 150, 250],
        });
      }
      const existing = await Notifications.getPermissionsAsync();
      let permission = existing.status;
      if (permission !== 'granted') permission = (await Notifications.requestPermissionsAsync()).status;
      if (permission !== 'granted') throw new Error('Notification permission was not granted.');

      const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
      if (!projectId) throw new Error('No EAS projectId is configured yet. The app still supports foreground/local alerts; create an EAS development build to enable server push.');
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await callApi('/api/push/register', { method: 'POST', body: JSON.stringify({ token }) });
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
      setPushToken(token);
      Alert.alert('Push enabled', 'This device is registered for GearBeacon server-side alerts, even when the app is closed.');
    } catch (err) {
      Alert.alert('Push setup', err instanceof Error ? err.message : String(err));
    }
  }

  async function disablePush() {
    try {
      if (pushToken) await callApi('/api/push/unregister', { method:'POST', body: JSON.stringify({ token: pushToken }) });
      await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
      setPushToken(null);
      Alert.alert('Push disabled', 'This device will no longer receive server-side GearBeacon push alerts.');
    } catch (err) {
      Alert.alert('Push setup', err instanceof Error ? err.message : String(err));
    }
  }

  async function saveNotificationPreferences() {
    try {
      const result = await callApi('/api/notifications/preferences', { method:'PUT', body: JSON.stringify({ preferences: notificationPrefs }) });
      setNotificationPrefs(result.preferences || notificationPrefs);
      Alert.alert('Saved', 'GearBeacon notification settings were updated.');
    } catch (err) {
      Alert.alert('Notification settings', err instanceof Error ? err.message : String(err));
    }
  }

  async function testNotification() {
    try {
      const result = await callApi('/api/notifications/test', { method:'POST' });
      const channels = (result.outcomes || []).filter((item: any) => item.ok).map((item: any) => item.channel).join(', ');
      Alert.alert('Test sent', channels ? `Delivered through: ${channels}` : 'GearBeacon sent a test notification.');
    } catch (err) {
      Alert.alert('Test notification', err instanceof Error ? err.message : String(err));
    }
  }

  const watched = useMemo(() => products.filter((p) => p.watched), [products]);
  const categories = useMemo(() => {
    const found: string[] = [...new Set<string>(products.map((p) => p.category).filter((value): value is string => Boolean(value)))];
    found.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a); const bi = CATEGORY_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return ['All', ...found];
  }, [products]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const categoryMatch = browseCategory === 'All' || p.category === browseCategory;
      const searchMatch = !q || `${p.name} ${p.slug} ${p.category}`.toLowerCase().includes(q);
      return categoryMatch && searchMatch;
    });
  }, [products, search, browseCategory]);

  useEffect(() => {
    if (!categories.includes(browseCategory)) setBrowseCategory('All');
  }, [categories, browseCategory]);

  function WatchCard({ item }: { item: Product }) {
    const stateColor = item.inStock ? styles.good : item.comingSoon ? styles.warn : styles.bad;
    return (
      <View style={styles.card}>
        <Pressable onPress={() => Linking.openURL(item.url)}><ProductImage item={item} styles={styles} /></Pressable>
        <View style={styles.cardBody}>
          <View style={styles.cardTop}>
            <View style={styles.badge}><View style={[styles.badgeDot, stateColor]} /><Text style={styles.badgeText}>{item.inStock ? 'In stock' : item.comingSoon ? 'Coming soon' : 'Sold out'}</Text></View>
            <Text style={styles.category}>{item.category}</Text>
          </View>
          <Text style={styles.productName}>{item.name}</Text>
          <Text style={styles.slug}>{item.slug}</Text>
          <Text style={styles.price}>{item.price || 'Price unavailable'}</Text>
          <Text style={styles.detail}>{productDetail(item)}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => toggleWatch(item)} style={[styles.button, item.watched && styles.buttonWatching]}><Text style={styles.buttonText}>{item.watched ? 'Watching ✓' : 'Watch'}</Text></Pressable>
            <Pressable onPress={() => Linking.openURL(item.url)} style={styles.button}><Text style={styles.buttonText}>Open store ↗</Text></Pressable>
          </View>
        </View>
      </View>
    );
  }

  function BrowseCard({ item }: { item: Product }) {
    return (
      <View style={styles.storeCard}>
        <Pressable onPress={() => Linking.openURL(item.url)}><ProductImage item={item} store styles={styles} /></Pressable>
        <View style={styles.storeCardBody}>
          <View style={styles.storeNameRow}>
            <Pressable style={{ flex: 1 }} onPress={() => Linking.openURL(item.url)}><Text numberOfLines={2} style={styles.storeProductName}>{item.name}</Text></Pressable>
            <Pressable accessibilityLabel={item.watched ? 'Remove from watchlist' : 'Watch product'} onPress={() => toggleWatch(item)} style={[styles.watchCircle, item.watched && styles.watchCircleActive]}><Text style={[styles.watchCircleText, item.watched && styles.watchCircleTextActive]}>{item.watched ? '✓' : '+'}</Text></Pressable>
          </View>
          <Text numberOfLines={1} style={styles.storeSku}>{item.slug}</Text>
          <Text style={styles.storePrice}>{item.price || 'Price unavailable'}</Text>
          <Text style={[styles.storeStock, item.inStock && styles.storeStockIn]}>{item.inStock ? 'In stock' : item.comingSoon ? 'Coming soon' : 'Sold out'}</Text>
          <Pressable onPress={() => toggleWatch(item)} style={[styles.storeWatchButton, item.watched && styles.storeWatchButtonActive]}><Text numberOfLines={1} style={[styles.storeWatchText, item.watched && styles.storeWatchTextActive]}>{item.watched ? 'Watching · alert on' : 'Notify me'}</Text></Pressable>
        </View>
      </View>
    );
  }

  function EventRow({ item }: { item: StockEvent }) {
    const symbol = item.type === 'restock' ? '↑' : item.type === 'sold_out' ? '↓' : item.type === 'price_change' ? '$' : item.type === 'new_product' ? '+' : '↔';
    return <Pressable onPress={() => Linking.openURL(item.url)} style={styles.eventRow}>
      <View style={styles.eventIcon}><Text style={styles.eventIconText}>{symbol}</Text></View>
      <View style={{ flex: 1 }}><Text style={styles.eventTitle}>{item.name}</Text><Text style={styles.eventMeta}>{item.type.replace('_', ' ')}{item.price ? ` · ${item.price}` : ''}{item.watchedAtDetection ? ' · watched' : ''}</Text></View>
      <Text style={styles.eventTime}>{relativeTime(item.detectedAt)}</Text>
    </Pressable>;
  }

  function Empty({ title, body, store = false }: { title: string; body: string; store?: boolean }) {
    return <View style={store ? styles.storeEmpty : styles.empty}><Text style={store ? styles.storeEmptyTitle : styles.emptyTitle}>{title}</Text><Text style={store ? styles.storeEmptyText : styles.emptyText}>{body}</Text></View>;
  }

  const browseHeader = (
    <View style={styles.storeHeader}>
      <Text style={styles.storeEyebrow}>UNIFI CATALOG</Text>
      <Text style={styles.storeTitle}>Browse products</Text>
      <Text style={styles.storeSubtitle}>Choose a category, then watch the gear you want.</Text>
      <View style={styles.storeSearchWrap}><Text style={styles.searchIcon}>⌕</Text><TextInput value={search} onChangeText={setSearch} placeholder="Search products" placeholderTextColor={colors.muted2} style={styles.storeSearch} autoCapitalize="none" /></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroller}>
        {categories.map((category) => {
          const count = category === 'All' ? products.length : products.filter((p) => p.category === category).length;
          const active = browseCategory === category;
          return <Pressable key={category} onPress={() => setBrowseCategory(category)} style={[styles.categoryTab, active && styles.categoryTabActive]}><Text style={[styles.categoryTabText, active && styles.categoryTabTextActive]}>{category}</Text><Text style={styles.categoryCount}> {count}</Text></Pressable>;
        })}
      </ScrollView>
      <View style={styles.resultsBar}><Text style={styles.resultsTitle}>{browseCategory === 'All' ? 'All products' : browseCategory}</Text><Text style={styles.resultsCount}>{filtered.length} product{filtered.length === 1 ? '' : 's'}</Text></View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle={themeMode === 'dark' ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>GB</Text></View>
          <View style={{ flex: 1 }}><Text style={styles.brand}>GearBeacon</Text><Text style={styles.tagline}>Know the second it's back.</Text></View>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onPress={toggleTheme} style={styles.themeButton}><Text style={styles.themeIcon}>{themeMode === 'dark' ? '☀' : '☾'}</Text></Pressable>
            <Pressable onPress={forceCheck} style={styles.checkButton}>{refreshing ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={styles.checkText}>Check</Text>}</Pressable>
          </View>
        </View>

        <View style={[styles.statusCard, error && styles.statusCardError]}>
          <View style={[styles.statusDot, error ? styles.bad : status?.lastSuccessAt ? styles.good : styles.warn]} />
          <View style={{ flex: 1 }}><Text style={styles.statusTitle}>{error ? 'Server unavailable' : status?.checking ? 'Checking store…' : status?.lastSuccessAt ? (status.mockMode ? 'Monitor online · MOCK' : 'Monitor online') : 'Starting monitor…'}</Text><Text numberOfLines={2} style={styles.statusSub}>{error || (status?.lastSuccessAt ? `Last success ${relativeTime(status.lastSuccessAt)} · ${status.productCount} products · ${status.region.toUpperCase()}` : 'Establishing baseline')}</Text></View>
        </View>

        {loading ? <View style={styles.center}><ActivityIndicator size="large" /><Text style={styles.muted}>Connecting to GearBeacon…</Text></View> : (
          <>
            {tab === 'watchlist' && <FlatList data={watched} keyExtractor={(p) => p.slug} renderItem={WatchCard} contentContainerStyle={styles.listContent} ListHeaderComponent={<View style={styles.sectionHead}><Text style={styles.sectionTitle}>Your watchlist</Text><Text style={styles.sectionSub}>{watched.length} product{watched.length === 1 ? '' : 's'} monitored</Text></View>} ListEmptyComponent={<Empty title="No products watched yet" body="Open Browse and add the gear you are waiting for." />} />}
            {tab === 'browse' && <FlatList key={`browse-${browseColumns}`} style={styles.storeList} data={filtered} numColumns={browseColumns} columnWrapperStyle={browseColumns > 1 ? styles.storeRow : undefined} keyExtractor={(p) => p.slug} renderItem={BrowseCard} contentContainerStyle={styles.storeListContent} ListHeaderComponent={browseHeader} ListEmptyComponent={<Empty store title="No matching products" body="Try another category or search." />} />}
            {tab === 'activity' && <FlatList data={events} keyExtractor={(e) => e.id} renderItem={EventRow} contentContainerStyle={styles.listContent} ListHeaderComponent={<View style={styles.sectionHead}><Text style={styles.sectionTitle}>Stock activity</Text><Text style={styles.sectionSub}>Exact detected transitions</Text></View>} ListEmptyComponent={<Empty title="No stock changes yet" body="The first observation establishes a baseline." />} />}
            {tab === 'settings' && <ScrollView style={styles.settings} contentContainerStyle={styles.settingsContent}>
              <Text style={styles.sectionTitle}>Settings</Text>
              <Text style={styles.sectionSub}>GearBeacon V{status?.version || Constants.expoConfig?.version || '1.4.0'}</Text>

              <Text style={styles.label}>Upgrade-safe data</Text>
              <Text style={styles.help}>Watched products are stored by the GearBeacon server in SQLite outside the application folder, so replacing the app does not replace your watchlist.</Text>
              <View style={styles.infoBox}>
                <Text style={styles.infoLine}>Storage: {dataInfo?.engine || status?.storage?.engine || 'SQLite'}</Text>
                <Text style={styles.infoLine}>Schema: v{dataInfo?.schemaVersion || status?.storage?.schemaVersion || '—'}</Text>
                <Text style={styles.infoLine}>Backups: {dataInfo?.backup?.count ?? '—'} / {dataInfo?.backup?.retention ?? 5} retained</Text>
                <Text style={styles.infoPath}>{dataInfo?.userDataDir || status?.storage?.userDataDir || '—'}</Text>
              </View>
              <View style={styles.settingsButtonStack}>
                <Pressable onPress={checkUpdates} style={styles.primaryWide}><Text style={styles.primaryWideText}>Check for updates</Text></Pressable>
                <Pressable onPress={createBackupNow} style={styles.button}><Text style={styles.buttonText}>Create backup now</Text></Pressable>
                <Pressable onPress={exportData} style={styles.button}><Text style={styles.buttonText}>Export GearBeacon data</Text></Pressable>
                <Pressable onPress={openDataTools} style={styles.button}><Text style={styles.buttonText}>Open Import / Export tools</Text></Pressable>
              </View>

              <View style={styles.divider} />
              <Text style={styles.label}>Notification events</Text>
              <Text style={styles.help}>Restocks are enabled by default. Other event types are optional and apply to watched products unless noted.</Text>
              <View style={styles.preferenceBox}>
                {([
                  ['restock', 'Restocks', 'Watched product becomes available'],
                  ['soldOut', 'Sold out', 'Watched product becomes unavailable'],
                  ['priceChange', 'Price changes', 'Price changes on a watched product'],
                  ['statusChange', 'Status changes', 'Other watched-product status changes'],
                  ['newProduct', 'New products', 'Any newly discovered catalog item'],
                ] as [keyof NotificationPreferences,string,string][]).map(([key, title, body]) => (
                  <View key={key} style={styles.preferenceRow}>
                    <View style={{ flex:1 }}><Text style={styles.preferenceTitle}>{title}</Text><Text style={styles.preferenceHelp}>{body}</Text></View>
                    <Switch value={notificationPrefs[key]} onValueChange={(value) => setNotificationPrefs((prefs) => ({ ...prefs, [key]: value }))} />
                  </View>
                ))}
              </View>
              <View style={styles.settingsButtonStack}>
                <Pressable onPress={saveNotificationPreferences} style={styles.primaryWide}><Text style={styles.primaryWideText}>Save notification settings</Text></Pressable>
                <Pressable onPress={testNotification} style={styles.button}><Text style={styles.buttonText}>Send test notification</Text></Pressable>
              </View>

              <View style={styles.divider} />
              <Text style={styles.label}>Remote push notifications</Text>
              <Text style={styles.help}>{pushToken ? 'This phone is registered for server-side GearBeacon push alerts.' : 'Register this phone to receive alerts even when GearBeacon is closed. An EAS development/release build is required.'}</Text>
              <Pressable onPress={pushToken ? disablePush : enablePush} style={styles.button}><Text style={styles.buttonText}>{pushToken ? 'Disable push on this device' : 'Register this device for push'}</Text></Pressable>

              <View style={styles.divider} />
              <Text style={styles.label}>GearBeacon server URL</Text>
              <TextInput value={apiDraft} onChangeText={setApiDraft} autoCapitalize="none" autoCorrect={false} style={styles.search} placeholder="http://192.168.1.50:8787" placeholderTextColor={colors.muted2} />
              <Text style={styles.help}>Use your computer's LAN IP for a local server, or your HTTPS GearBeacon URL for a cloud deployment.</Text>
              <Pressable onPress={saveApi} style={styles.primaryWide}><Text style={styles.primaryWideText}>Save server URL</Text></Pressable>
              <View style={styles.divider} />
              <Text style={styles.help}>Region: {status?.regionLabel || '—'} · Poll interval: {status?.pollSeconds || '—'}s · Health: {status?.catalogHealth || '—'}</Text>
            </ScrollView>}
          </>
        )}

        <View style={styles.tabbar}>
          {(['watchlist','browse','activity','settings'] as Tab[]).map((name) => <Pressable key={name} onPress={() => setTab(name)} style={[styles.tabItem, tab === name && styles.tabItemActive]}><Text style={[styles.tabText, tab === name && styles.tabTextActive]}>{name === 'watchlist' ? `Watch ${watched.length}` : name[0].toUpperCase() + name.slice(1)}</Text></Pressable>)}
        </View>
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    container: { flex: 1, backgroundColor: c.bg },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 11 },
    brandMark: { width: 42, height: 42, borderRadius: 13, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' },
    brandMarkText: { color: c.text, fontWeight: '800' },
    brand: { color: c.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.5 },
    tagline: { color: c.muted, fontSize: 12, marginTop: 1 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    themeButton: { width: 38, height: 38, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2 },
    themeIcon: { color: c.text, fontSize: 17, lineHeight: 20 },
    checkButton: { minWidth: 62, height: 38, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2 },
    checkText: { color: c.text, fontWeight: '700' },
    statusCard: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, flexDirection: 'row', alignItems: 'center', gap: 10 },
    statusCardError: { borderColor: c.bad },
    statusDot: { width: 9, height: 9, borderRadius: 99 },
    good: { backgroundColor: c.good }, bad: { backgroundColor: c.bad }, warn: { backgroundColor: c.warn },
    statusTitle: { color: c.text, fontWeight: '700', fontSize: 13 },
    statusSub: { color: c.muted, fontSize: 11, marginTop: 2 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
    muted: { color: c.muted },
    listContent: { paddingHorizontal: 16, paddingBottom: 100 },
    sectionHead: { marginTop: 14, marginBottom: 12 },
    sectionTitle: { color: c.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
    sectionSub: { color: c.muted, fontSize: 12, marginTop: 3 },
    search: { borderWidth: 1, borderColor: c.border, backgroundColor: c.input, color: c.text, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 11, marginBottom: 12 },
    card: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 14, marginBottom: 10, overflow: 'hidden' },
    cardBody: { padding: 14 },
    watchMedia: { height: 190, backgroundColor: c.image, position: 'relative', overflow: 'hidden' },
    watchProductImage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, margin: 15 },
    imagePlaceholder: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: c.image },
    cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
    badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 5 },
    badgeDot: { width: 6, height: 6, borderRadius: 99 },
    badgeText: { color: c.muted, fontSize: 11 },
    category: { color: c.muted, fontSize: 11, flexShrink: 1 },
    productName: { color: c.text, fontSize: 16, fontWeight: '700', marginTop: 10 },
    slug: { color: c.muted2, fontSize: 11, marginTop: 2 },
    price: { color: c.text, fontSize: 20, fontWeight: '800', marginTop: 11 },
    detail: { color: c.muted, fontSize: 11, marginTop: 2 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 13 },
    button: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: c.border, backgroundColor: c.button, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
    buttonWatching: { borderColor: c.accent, backgroundColor: c.accentSoft },
    buttonText: { color: c.text, fontWeight: '700', fontSize: 12 },

    storeList: { flex: 1, backgroundColor: c.storeBg, marginTop: 6 },
    storeListContent: { paddingBottom: 105, backgroundColor: c.storeBg },
    storeHeader: { backgroundColor: c.storeBg, paddingTop: 23 },
    storeEyebrow: { color: c.storeMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 16 },
    storeTitle: { color: c.storeText, fontSize: 27, fontWeight: '800', letterSpacing: -0.8, marginTop: 5, paddingHorizontal: 16 },
    storeSubtitle: { color: c.storeMuted, fontSize: 12, marginTop: 5, paddingHorizontal: 16 },
    storeSearchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 17, borderWidth: 1, borderColor: c.storeLine, backgroundColor: c.input, borderRadius: 9, paddingHorizontal: 11 },
    searchIcon: { color: c.storeMuted, fontSize: 16 },
    storeSearch: { flex: 1, color: c.storeText, paddingVertical: Platform.OS === 'ios' ? 11 : 9, fontSize: 13 },
    categoryScroller: { paddingHorizontal: 16, marginTop: 9, borderBottomWidth: 1, borderBottomColor: c.storeLine, gap: 21 },
    categoryTab: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 2, borderBottomColor: 'transparent' },
    categoryTabActive: { borderBottomColor: c.storeText },
    categoryTabText: { color: c.storeMuted, fontSize: 12, fontWeight: '500' },
    categoryTabTextActive: { color: c.storeText, fontWeight: '700' },
    categoryCount: { color: c.muted2, fontSize: 10 },
    resultsBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 15 },
    resultsTitle: { color: c.storeText, fontWeight: '700', fontSize: 13 },
    resultsCount: { color: c.storeMuted, fontSize: 10 },
    storeRow: { paddingHorizontal: 8, gap: 8 },
    storeCard: { flex: 1, minWidth: 0, backgroundColor: c.storeCard, borderWidth: 1, borderColor: c.storeLine, borderRadius: 10, overflow: 'hidden', marginBottom: 8 },
    storeMedia: { height: 150, backgroundColor: c.image, position: 'relative', overflow: 'hidden' },
    storeProductImage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, margin: 14 },
    storeCardBody: { paddingHorizontal: 10, paddingTop: 10, paddingBottom: 11 },
    storeNameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    storeProductName: { color: c.storeText, fontSize: 12, fontWeight: '700', lineHeight: 16, minHeight: 32 },
    watchCircle: { width: 25, height: 25, borderRadius: 99, borderWidth: 1, borderColor: c.storeLine, alignItems: 'center', justifyContent: 'center', backgroundColor: c.storeCard },
    watchCircleActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    watchCircleText: { color: c.storeMuted, fontSize: 17, lineHeight: 19 },
    watchCircleTextActive: { color: c.storeText, fontWeight: '800', fontSize: 13 },
    storeSku: { color: c.muted2, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 4 },
    storePrice: { color: c.storeText, fontSize: 12, fontWeight: '700', marginTop: 10 },
    storeStock: { color: c.bad, fontSize: 9, marginTop: 2 },
    storeStockIn: { color: c.good },
    storeWatchButton: { marginTop: 10, minHeight: 32, borderWidth: 1, borderColor: c.storeLine, borderRadius: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, backgroundColor: c.storeCard },
    storeWatchButtonActive: { backgroundColor: c.accentSoft, borderColor: c.accent },
    storeWatchText: { color: c.storeText, fontSize: 9.5, fontWeight: '700' },
    storeWatchTextActive: { color: c.storeText },
    storeEmpty: { borderWidth: 1, borderStyle: 'dashed', borderColor: c.storeLine, borderRadius: 12, padding: 30, alignItems: 'center', marginHorizontal: 16, marginTop: 4 },
    storeEmptyTitle: { color: c.storeText, fontWeight: '700', fontSize: 15 },
    storeEmptyText: { color: c.storeMuted, textAlign: 'center', marginTop: 5, lineHeight: 18 },

    eventRow: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 12, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
    eventIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.panel3, alignItems: 'center', justifyContent: 'center' },
    eventIconText: { color: c.text, fontSize: 18, fontWeight: '800' },
    eventTitle: { color: c.text, fontWeight: '700', fontSize: 13 },
    eventMeta: { color: c.muted, fontSize: 11, marginTop: 2 },
    eventTime: { color: c.muted2, fontSize: 10 },
    empty: { borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: 14, padding: 30, alignItems: 'center', marginTop: 6, backgroundColor: c.panel },
    emptyTitle: { color: c.text, fontWeight: '700', fontSize: 15 },
    emptyText: { color: c.muted, textAlign: 'center', marginTop: 5, lineHeight: 18 },
    settings: { flex: 1, backgroundColor: c.bg },
    settingsContent: { padding: 16, paddingBottom: 120 },
    infoBox: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 12, padding: 12, gap: 5 },
    infoLine: { color: c.text, fontSize: 12, fontWeight: '600' },
    infoPath: { color: c.muted2, fontSize: 10, marginTop: 4 },
    settingsButtonStack: { gap: 8, marginTop: 12 },
    preferenceBox: { borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, borderRadius: 12, overflow: 'hidden' },
    preferenceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.border },
    preferenceTitle: { color: c.text, fontSize: 12, fontWeight: '700' },
    preferenceHelp: { color: c.muted, fontSize: 10.5, marginTop: 2, lineHeight: 15 },
    label: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 22, marginBottom: 8 },
    help: { color: c.muted, fontSize: 12, lineHeight: 18, marginBottom: 12 },
    primaryWide: { borderRadius: 10, backgroundColor: c.primary, padding: 12, alignItems: 'center' },
    primaryWideText: { color: c.primaryText, fontWeight: '800' },
    divider: { height: 1, backgroundColor: c.border, marginTop: 22 },
    tabbar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.border, flexDirection: 'row', paddingHorizontal: 8, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 18 : 10 },
    tabItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 9 },
    tabItemActive: { backgroundColor: c.panel3 },
    tabText: { color: c.muted, fontSize: 11, fontWeight: '700' },
    tabTextActive: { color: c.text },
  });
}
