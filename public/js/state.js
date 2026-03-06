export const state = {
  // Search panel
  view: 'podcasts',            // 'podcasts' | 'episodes'
  podcastResults: [],          // results from podcast search
  episodeResults: [],          // episodes for the active podcast
  activePodcast: null,         // {id, title, publisher, thumbnail, total_episodes}
  nextEpisodePubDate: null,    // for pagination
  // Knowledge base
  episodes: [],                // {id, title, podcast, thumbnail, transcript, status}
  // Chat
  chatHistory: [],             // [{role, content}]
  // Collections
  collections: [],       // [{id, name, frequency, day_of_week, no_episodes_behavior, last_sent_at, feed_count}]
  collectionsOpen: false,
  // Loading flags
  searching: false,
  loadingEpisodes: false,
  chatting: false,
};
