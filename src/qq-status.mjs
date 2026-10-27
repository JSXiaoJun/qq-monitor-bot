// Tracks whether the QQ account behind NapCat is logged in. The WebSocket can stay
// connected while the account itself has been kicked offline, so /health needs both.
export const createQqStatusTracker = ({ now = () => new Date() } = {}) => {
  let online = null
  let reason = ''
  let changedAt = now().toISOString()

  const update = (value, why = '') => {
    const changed = online !== value
    if (changed) changedAt = now().toISOString()
    online = value
    reason = value === false ? why : ''
    return changed
  }

  return {
    // Returns true when the online state changed.
    observeEvent(payload) {
      if (payload?.post_type === 'meta_event' && payload?.meta_event_type === 'heartbeat') {
        const value = payload?.status?.online
        return typeof value === 'boolean' ? update(value, '心跳显示 QQ 未在线') : false
      }
      if (payload?.post_type === 'notice' && payload?.notice_type === 'bot_offline') {
        return update(false, String(payload?.message || payload?.tag || 'QQ 账号被下线').trim())
      }
      return false
    },
    applyStatus(data) {
      const value = data?.online
      return typeof value === 'boolean' ? update(value, 'get_status 显示 QQ 未在线') : false
    },
    reset() {
      return update(null)
    },
    snapshot() {
      return {
        qq_online: online,
        qq_status_reason: reason,
        qq_status_changed_at: changedAt,
      }
    },
  }
}
