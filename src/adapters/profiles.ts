import { AppComponents, ProfileMetadata } from '../types'
import { Avatar, Entity, Snapshots } from '@dcl/schemas'
import { parseUrn } from '@dcl/urn-resolver'
import { splitUrnAndTokenId } from '../logic/utils'

function isBaseWearable(wearable: string): boolean {
  return wearable.includes('base-avatars')
}

const URN_THIRD_PARTY_ASSET_TYPE = 'blockchain-collection-third-party'

export async function translateWearablesIdFormat(wearableId: string): Promise<string | undefined> {
  if (!wearableId.startsWith('dcl://')) {
    return wearableId
  }

  const parsed = await parseUrn(wearableId)
  return parsed?.uri?.toString()
}

// Dates received from If-Modified-Since headers have precisions of seconds, so we need to round
function roundToSeconds(timestamp: number) {
  return Math.floor(timestamp / 1000) * 1000
}

/**
 * The content server provides the snapshots' hashes, but clients expect a full url. So in this
 * method, we replace the hashes by urls that would trigger the snapshot download.
 */
function addBaseUrlToSnapshots(baseUrl: string, snapshots: Snapshots, content: Map<string, string>): Snapshots {
  snapshots.body = addBaseUrlToSnapshot(baseUrl, snapshots.body, content)
  snapshots.face256 = addBaseUrlToSnapshot(baseUrl, snapshots.face256, content)
  return snapshots
}

function addBaseUrlToSnapshot(baseUrl: string, snapshot: string, content: Map<string, string>): string {
  const cleanedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  if (content.has(snapshot)) {
    // Snapshot references a content file
    const hash = content.get(snapshot)!
    return cleanedBaseUrl + `contents/${hash}`
  } else {
    // Snapshot is directly a hash
    return cleanedBaseUrl + `contents/${snapshot}`
  }
}

export type IProfilesComponent = {
  getProfiles(
    ethAddresses: string[],
    ifModifiedSinceTimestamp?: number | undefined
  ): Promise<ProfileMetadata[] | undefined>

  getProfile(ethAddresses: string): Promise<ProfileMetadata | undefined>
}

export async function createProfilesComponent(
  components: Pick<
    AppComponents,
    | 'metrics'
    | 'content'
    | 'theGraph'
    | 'config'
    | 'fetch'
    | 'ownershipCaches'
    | 'logs'
    | 'wearablesFetcher'
    | 'emotesFetcher'
    | 'namesFetcher'
  >
): Promise<IProfilesComponent> {
  const { content, wearablesFetcher, emotesFetcher, namesFetcher, config, logs } = components
  const logger = logs.getLogger('profiles')

  const ensureERC721 = (await config.getString('ENSURE_ERC_721')) !== 'false'
  const baseUrl = (await config.getString('CONTENT_URL')) ?? ''

  async function getProfiles(
    ethAddresses: string[],
    ifModifiedSinceTimestamp?: number | undefined
  ): Promise<ProfileMetadata[] | undefined> {
    try {
      let profileEntities: Entity[] = await content.fetchEntitiesByPointers(ethAddresses)

      // Avoid querying profiles if there wasn't any new deployment
      if (
        ifModifiedSinceTimestamp &&
        profileEntities.every((it) => roundToSeconds(it.timestamp) <= ifModifiedSinceTimestamp)
      ) {
        return
      }

      profileEntities = profileEntities.filter((entity) => !!entity.metadata)

      return await Promise.all(
        profileEntities.map(async (entity) => {
          const ethAddress = entity.pointers[0]
          const metadata: ProfileMetadata = entity.metadata
          const content = new Map((entity.content ?? []).map(({ file, hash }) => [file, hash]))

          metadata.timestamp = entity.timestamp

          const [ownedWearables, ownedEmotes, ownedNames] = await Promise.all([
            wearablesFetcher.fetchOwnedElements(ethAddress),
            emotesFetcher.fetchOwnedElements(ethAddress),
            namesFetcher.fetchOwnedElements(ethAddress)
          ])

          const avatars: Avatar[] = []
          const validatedWearables: string[] = []
          const thirdPartyWearables: string[] = []
          const validatedEmotes: { slot: number; urn: string }[] = []
          for (const avatar of metadata.avatars) {
            for (const wearableId of avatar.avatar.wearables) {
              if (isBaseWearable(wearableId)) {
                validatedWearables.push(wearableId)
                continue
              }

              const parsed = await parseUrn(wearableId)
              if (parsed?.type === URN_THIRD_PARTY_ASSET_TYPE) {
                validatedWearables.push(wearableId)
                continue
              }

              let wearable: string
              if (!wearableId.startsWith('dcl://')) {
                wearable = wearableId
              } else if (parsed && parsed.uri) {
                wearable = parsed.uri.toString()
              } else {
                continue
              }

              const { urn, tokenId } = splitUrnAndTokenId(wearable)

              const matchingOwnedWearable = ownedWearables.find(
                (ownedWearable) =>
                  ownedWearable.urn === urn &&
                  (!tokenId || ownedWearable.individualData.find((itemData) => itemData.tokenId === tokenId))
              )

              if (matchingOwnedWearable) {
                validatedWearables.push(
                  ensureERC721
                    ? `${matchingOwnedWearable.urn}:${
                        tokenId ? tokenId : matchingOwnedWearable.individualData[0].tokenId
                      }`
                    : matchingOwnedWearable.urn
                )
              }
            }

            for (const emote of avatar.avatar.emotes ?? []) {
              if (!emote.urn.includes(':')) {
                validatedEmotes.push(emote)
                continue
              }

              const { urn, tokenId } = splitUrnAndTokenId(emote.urn)

              const matchingOwnedEmote = ownedEmotes.find(
                (ownedEmote) =>
                  ownedEmote.urn === urn &&
                  (!tokenId || ownedEmote.individualData.find((itemData) => itemData.tokenId === tokenId))
              )

              if (matchingOwnedEmote) {
                const urnToReturn = ensureERC721
                  ? `${matchingOwnedEmote.urn}:${tokenId ? tokenId : matchingOwnedEmote.individualData[0].tokenId}`
                  : matchingOwnedEmote.urn

                validatedEmotes.push({ urn: urnToReturn, slot: emote.slot })
              }
            }

            avatars.push({
              ...avatar,
              hasClaimedName: ownedNames.findIndex((name) => name.name === avatar.name) !== -1,
              avatar: {
                ...avatar.avatar,
                emotes: validatedEmotes,
                bodyShape: (await translateWearablesIdFormat(avatar.avatar.bodyShape)) ?? '',
                snapshots: addBaseUrlToSnapshots(baseUrl, avatar.avatar.snapshots, content),
                wearables: Array.from(new Set(validatedWearables.concat(thirdPartyWearables)))
              }
            })
          }
          return {
            timestamp: metadata.timestamp,
            avatars
          }
        })
      )
    } catch (error: any) {
      logger.error(error)
      return []
    }
  }

  async function getProfile(ethAddress: string): Promise<ProfileMetadata | undefined> {
    const profiles = await getProfiles([ethAddress])
    return profiles && profiles.length > 0 ? profiles[0] : undefined
  }

  return {
    getProfiles,
    getProfile
  }
}
