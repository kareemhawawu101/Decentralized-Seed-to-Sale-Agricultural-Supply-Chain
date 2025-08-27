;; ProvenanceRegistry.clar
;; Core smart contract for tracking crop provenance in the Decentralized Seed-to-Sale Agricultural Supply Chain.
;; This contract manages immutable records of crop lifecycle stages, ensuring transparency and trust.
;; It integrates with CropToken (NFTs) and FarmerRegistry for authorization.
;; Features include staged updates, metadata validation, event logging, access controls, and query functions.

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-TOKEN-ID u101)
(define-constant ERR-INVALID-STAGE u102)
(define-constant ERR-PAUSED u103)
(define-constant ERR-ALREADY-INITIALIZED u104)
(define-constant ERR-METADATA-TOO-LONG u105)
(define-constant ERR-INVALID-UPDATER u106)
(define-constant ERR-STAGE-OUT-OF-ORDER u107)
(define-constant ERR-TOKEN-NOT-REGISTERED u108)
(define-constant ERR-ALREADY-AT-FINAL-STAGE u109)
(define-constant ERR-INVALID-LOCATION u110)
(define-constant ERR-UPDATER-ALREADY_REGISTERED u111)
(define-constant ERR-NOT-FOUND u112)
(define-constant ERR-INVALID-PARAM u113)

(define-constant MAX-METADATA-LEN u1000)
(define-constant MAX-LOCATION-LEN u64) ;; For hashed GPS or other location data

;; Predefined stages (uint codes for efficiency)
(define-constant STAGE-PLANTING u0)
(define-constant STAGE-GROWING u1)
(define-constant STAGE-HARVESTING u2)
(define-constant STAGE-PROCESSING u3)
(define-constant STAGE-SHIPPING u4)
(define-constant STAGE-SALE u5)
(define-constant MAX-STAGE STAGE-SALE)

;; Data Variables
(define-data-var contract-admin principal tx-sender)
(define-data-var is-paused bool false)
(define-data-var total-updates uint u0)

;; Maps
;; provenance-history: Stores sequential updates for each token
(define-map provenance-history
  { token-id: uint, stage: uint }
  {
    timestamp: uint,
    updater: principal,
    metadata: (string-utf8 1000),
    location-hash: (optional (buff 64)), ;; Hashed location data (e.g., GPS coordinates)
    verified: bool ;; Can be verified by community or oracle later
  }
)

;; current-stage: Tracks the latest stage for each token
(define-map current-stage
  { token-id: uint }
  { stage: uint }
)

;; registered-tokens: Basic registration for tokens (assumes called after minting in CropToken)
(define-map registered-tokens
  { token-id: uint }
  { registered-at: uint, owner: principal }
)

;; authorized-updaters: Per-token authorized principals (e.g., farmer, logistics partner)
(define-map authorized-updaters
  { token-id: uint, updater: principal }
  { role: (string-utf8 50), added-at: uint }
)

;; update-count: Tracks number of updates per token
(define-map update-count
  { token-id: uint }
  { count: uint }
)

;; Traits (for integration with other contracts)
(define-trait farmer-registry-trait
  (
    (is-verified-farmer (principal) (response bool uint))
  )
)

(define-trait crop-token-trait
  (
    (get-owner (uint) (response principal uint))
    (is-valid-token (uint) (response bool uint))
  )
)

;; Data var for trait references (set by admin)
(define-data-var farmer-registry-contract principal tx-sender) ;; Placeholder, set to actual contract
(define-data-var crop-token-contract principal tx-sender) ;; Placeholder

;; Private Functions
(define-private (is-admin (caller principal))
  (is-eq caller (var-get contract-admin))
)

(define-private (validate-stage-order (token-id uint) (new-stage uint))
  (let ((curr (default-to u0 (get stage (map-get? current-stage {token-id: token-id})))))
    (if (or (> new-stage MAX-STAGE) (<= new-stage curr))
        false
        true)
  )
)

(define-private (check-authorized (token-id uint) (caller principal))
  (or
    (is-eq caller (unwrap! (as-contract (contract-call? .crop-token get-owner token-id)) (err ERR-UNAUTHORIZED))) ;; Assume .crop-token implements crop-token-trait
    (is-some (map-get? authorized-updaters {token-id: token-id, updater: caller}))
  )
)

(define-private (emit-event (event-type (string-ascii 32)) (data (string-utf8 500)))
  (print { event: event-type, data: data, timestamp: block-height })
)

;; Public Functions
(define-public (set-farmer-registry (new-registry principal))
  (if (is-admin tx-sender)
    (ok (var-set farmer-registry-contract new-registry))
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (set-crop-token (new-token-contract principal))
  (if (is-admin tx-sender)
    (ok (var-set crop-token-contract new-token-contract))
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (pause-contract)
  (if (is-admin tx-sender)
    (ok (var-set is-paused true))
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (unpause-contract)
  (if (is-admin tx-sender)
    (ok (var-set is-paused false))
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (transfer-admin (new-admin principal))
  (if (is-admin tx-sender)
    (ok (var-set contract-admin new-admin))
    (err ERR-UNAUTHORIZED)
  )
)

(define-public (register-token (token-id uint))
  (let ((owner (unwrap! (as-contract (contract-call? .crop-token get-owner token-id)) (err ERR-INVALID-TOKEN-ID))))
    (if (is-some (map-get? registered-tokens {token-id: token-id}))
      (err ERR-ALREADY-INITIALIZED)
      (begin
        (map-set registered-tokens {token-id: token-id} {registered-at: block-height, owner: owner})
        (map-set current-stage {token-id: token-id} {stage: u0})
        (map-set update-count {token-id: token-id} {count: u0})
        (emit-event "token-registered" (concat "Token ID: " (int-to-utf8 token-id)))
        (ok true)
      )
    )
  )
)

(define-public (add-provenance-entry 
  (token-id uint) 
  (stage uint) 
  (metadata (string-utf8 1000)) 
  (location-hash (optional (buff 64))))
  (let 
    (
      (caller tx-sender)
      (is-verified (unwrap! (as-contract (contract-call? .farmer-registry is-verified-farmer caller)) (err ERR-INVALID-UPDATER)))
    )
    (if (var-get is-paused)
      (err ERR-PAUSED)
      (if (not is-verified)
        (err ERR-INVALID-UPDATER)
        (if (not (is-some (map-get? registered-tokens {token-id: token-id})))
          (err ERR-TOKEN-NOT-REGISTERED)
          (if (not (check-authorized token-id caller))
            (err ERR-UNAUTHORIZED)
            (if (not (validate-stage-order token-id stage))
              (err ERR-STAGE-OUT-OF-ORDER)
              (if (> (len metadata) MAX-METADATA-LEN)
                (err ERR-METADATA-TOO-LONG)
                (match location-hash loc
                  (if (> (len loc) MAX-LOCATION-LEN)
                    (err ERR-INVALID-LOCATION)
                    (begin
                      (map-set provenance-history
                        {token-id: token-id, stage: stage}
                        {
                          timestamp: block-height,
                          updater: caller,
                          metadata: metadata,
                          location-hash: location-hash,
                          verified: false
                        }
                      )
                      (map-set current-stage {token-id: token-id} {stage: stage})
                      (let ((new-count (+ (default-to u0 (get count (map-get? update-count {token-id: token-id}))) u1)))
                        (map-set update-count {token-id: token-id} {count: new-count})
                        (var-set total-updates (+ (var-get total-updates) u1))
                      )
                      (emit-event "provenance-updated" (concat "Token: " (int-to-utf8 token-id)))
                      (ok true)
                    )
                  )
                  (err ERR-INVALID-PARAM) ;; If location provided but invalid
                )
              )
            )
          )
        )
      )
    )
  )
)

(define-public (verify-entry (token-id uint) (stage uint))
  (let ((entry (map-get? provenance-history {token-id: token-id, stage: stage})))
    (if (is-some entry)
      (if (is-admin tx-sender) ;; Or could be community vote, but for now admin
        (begin
          (map-set provenance-history {token-id: token-id, stage: stage}
            (merge (unwrap-panic entry) {verified: true}))
          (emit-event "entry-verified" (concat "Token: " (int-to-utf8 token-id)))
          (ok true)
        )
        (err ERR-UNAUTHORIZED)
      )
      (err ERR-NOT-FOUND)
    )
  )
)

(define-public (add-authorized-updater (token-id uint) (updater principal) (role (string-utf8 50)))
  (let ((owner (get owner (unwrap-panic (map-get? registered-tokens {token-id: token-id})))))
    (if (is-eq tx-sender owner)
      (if (is-some (map-get? authorized-updaters {token-id: token-id, updater: updater}))
        (err ERR-UPDATER-ALREADY_REGISTERED)
        (begin
          (map-set authorized-updaters {token-id: token-id, updater: updater} {role: role, added-at: block-height})
          (emit-event "updater-added" (concat "Updater for token: " (int-to-utf8 token-id)))
          (ok true)
        )
      )
      (err ERR-UNAUTHORIZED)
    )
  )
)

(define-public (remove-authorized-updater (token-id uint) (updater principal))
  (let ((owner (get owner (unwrap-panic (map-get? registered-tokens {token-id: token-id})))))
    (if (is-eq tx-sender owner)
      (begin
        (map-delete authorized-updaters {token-id: token-id, updater: updater})
        (emit-event "updater-removed" (concat "Updater for token: " (int-to-utf8 token-id)))
        (ok true)
      )
      (err ERR-UNAUTHORIZED)
    )
  )
)

;; Read-Only Functions
(define-read-only (get-current-stage (token-id uint))
  (ok (default-to u0 (get stage (map-get? current-stage {token-id: token-id}))))
)

(define-read-only (get-provenance-entry (token-id uint) (stage uint))
  (map-get? provenance-history {token-id: token-id, stage: stage})
)

(define-read-only (get-full-history (token-id uint))
  (let ((curr-stage (default-to u0 (get stage (map-get? current-stage {token-id: token-id})))))
    (fold 
      (lambda (stage acc)
        (match (map-get? provenance-history {token-id: token-id, stage: stage})
          entry (append acc entry)
          acc
        )
      )
      (list STAGE-PLANTING STAGE-GROWING STAGE-HARVESTING STAGE-PROCESSING STAGE-SHIPPING STAGE-SALE)
      (list)
    )
  )
)

(define-read-only (is-registered-token (token-id uint))
  (is-some (map-get? registered-tokens {token-id: token-id}))
)

(define-read-only (get-authorized-updaters (token-id uint) (updater principal))
  (map-get? authorized-updaters {token-id: token-id, updater: updater})
)

(define-read-only (get-total-updates)
  (var-get total-updates)
)

(define-read-only (is-contract-paused)
  (var-get is-paused)
)

(define-read-only (get-admin)
  (var-get contract-admin)
)