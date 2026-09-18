const kDiscordUrl = 'https://discord.gg/AzVtMnSxCe';
const kTelegramUrl = 'https://t.me/shearprivacy';
const kXUrl = 'https://x.com/shearprivacy';
const kRedditUrl = 'https://www.reddit.com/r/shear/';

/// Hosts Continuum may open. No shorteners, no outbound-click wrappers.
const kSocialHosts = {
  'discord.gg',
  'discord.com',
  'www.discord.com',
  't.me',
  'www.t.me',
  'telegram.me',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'www.reddit.com',
  'reddit.com',
  'old.reddit.com',
};

/// https only, allowlisted host, no userInfo/query/fragment (utm, fbclid, si, …).
Uri? socialUri(String url) {
  final parsed = Uri.tryParse(url.trim());
  if (parsed == null) return null;
  if (parsed.scheme != 'https' && parsed.scheme != 'http') return null;
  final host = parsed.host.toLowerCase();
  if (host.isEmpty || !kSocialHosts.contains(host)) return null;
  if (parsed.hasPort && parsed.port != 443 && parsed.port != 80) return null;
  var path = parsed.path;
  if (path.isEmpty) path = '/';
  if (path.contains('//') || path.contains(r'\') || path.contains('@')) {
    return null;
  }
  return Uri(scheme: 'https', host: host, path: path);
}
